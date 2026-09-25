// Busca o estado atual dos 3 projetos no Linear e regenera as partes "ao vivo" do
// index.html (colunas Em execução/QA/Produção, barra de distribuição, Áreas
// envolvidas e progresso dos Marcos). Não mexe em Objetivo/Próximo goal/Blockers/
// KPIs manuais — essas seções continuam só mudando via Claude (na checagem
// manual ou no fechamento de sexta), exatamente como hoje.
//
// ATENÇÃO: os nomes de campo da API GraphQL do Linear abaixo seguem a doc pública
// (developers.linear.app/docs/graphql). Antes de deixar isso em produção, rode
// `node scripts/rebuild-board.mjs` uma vez localmente com a LINEAR_API_KEY num
// .env e confira o index.html gerado — GraphQL schemas mudam, então vale
// confirmar os nomes exatos de campo (em especial `progress` do milestone).

import { readFileSync, writeFileSync } from "node:fs";

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
if (!LINEAR_API_KEY) {
  console.error("Faltou LINEAR_API_KEY no ambiente.");
  process.exit(1);
}

const PROJECTS = {
  "anti-banking": {
    projectId: "47c55255-de0a-45c0-9919-04e1f2132355",
    milestoneId: "b509ffa0-550b-4014-9d82-1d7453329bb8",
  },
  "anti-sacado": {
    projectId: "37062b7b-23d9-4724-af18-54bbe6b8720d",
    milestoneId: "3d10d969-f786-478e-ac8b-4d6113eff382",
  },
  "decentral": {
    projectId: "c070788d-b8fe-4acf-a8c7-b3f137d132ed",
    milestoneId: "4710851e-7c2d-4313-8c94-b3676bd46a4b",
  },
};

// Mapeamento dos status reais do time DUX para as 3 colunas do board.
const COL_MAP = {
  "In Progress": "progress",
  "QA - In Test": "qa",
};
const DONE_TYPES = new Set(["completed"]); // statusType "completed" -> Produção
const BACKLOG_ORDER = ["Backlog", "Product Refinement", "Priorized", "Ready To Dev", "In Review"];

async function linearQuery(query, variables) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": LINEAR_API_KEY },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchProjectIssues(projectId) {
  const query = `
    query($projectId: ID!) {
      issues(filter: { project: { id: { eq: $projectId } } }, first: 250) {
        nodes {
          identifier
          title
          state { name type }
          labels { nodes { name } }
          assignee { name }
          completedAt
          createdAt
        }
      }
    }`;
  const data = await linearQuery(query, { projectId });
  return data.issues.nodes;
}

async function fetchMilestoneProgress(milestoneId) {
  const query = `
    query($id: String!) {
      projectMilestone(id: $id) {
        name
        progress
        targetDate
      }
    }`;
  const data = await linearQuery(query, { id: milestoneId });
  return data.projectMilestone;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildBoardHtml(issues) {
  const progress = issues.filter((i) => i.state.name === "In Progress");
  const qa = issues.filter((i) => i.state.name === "QA - In Test");
  const done = issues
    .filter((i) => i.state.type === "completed")
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .slice(0, 1);

  const col = (items, emptyMsg) =>
    items.length
      ? items.map((i) => `<div class="task"><span class="id mono">${esc(i.identifier)}</span><span>${esc(i.title)}${i.assignee ? `<span class="who">${esc(i.assignee.name)}</span>` : ""}</span></div>`).join("\n")
      : `<div class="empty">${emptyMsg}</div>`;

  return {
    progress: col(progress, "Nenhuma task em execução"),
    qa: col(qa, "Nenhuma task em QA"),
    done: col(done, "Nenhuma entrega em produção ainda"),
  };
}

function buildDistroHtml(issues) {
  const open = issues.filter((i) => i.state.type !== "completed" && i.state.type !== "canceled");
  const counts = {};
  for (const i of open) counts[i.state.name] = (counts[i.state.name] || 0) + 1;
  const total = open.length || 1;
  const order = Object.keys(counts).sort((a, b) => BACKLOG_ORDER.indexOf(a) - BACKLOG_ORDER.indexOf(b));
  const bars = order.map((name) => `<div style="width:${((counts[name] / total) * 100).toFixed(1)}%"></div>`).join("\n");
  const legend = order.map((name) => `<span><span class="dot"></span>${esc(name)} · ${counts[name]}</span>`).join("\n");
  return { bars, legend };
}

function buildAreasHtml(issues) {
  let mkt = 0, fin = 0, other = 0;
  for (const i of issues) {
    const labels = i.labels.nodes.map((l) => l.name);
    if (labels.includes("Marketing")) mkt++;
    else if (labels.includes("Financeiro")) fin++;
    else other++;
  }
  return `<span class="chip mkt">Marketing · ${mkt}</span>\n<span class="chip fin">Financeiro · ${fin}</span>\n<span class="chip other">Outros · ${other}</span>`;
}

function replaceMarker(html, key, section, content) {
  const re = new RegExp(`(<!--\\s*LIVE:${key}:${section}:start\\s*-->)([\\s\\S]*?)(<!--\\s*LIVE:${key}:${section}:end\\s*-->)`);
  if (!re.test(html)) {
    console.warn(`Aviso: marcador LIVE:${key}:${section} não encontrado no index.html — pulei essa seção.`);
    return html;
  }
  return html.replace(re, `$1\n${content}\n$3`);
}

async function main() {
  let html = readFileSync("index.html", "utf8");

  for (const [key, cfg] of Object.entries(PROJECTS)) {
    const issues = await fetchProjectIssues(cfg.projectId);
    const board = buildBoardHtml(issues);
    const distro = buildDistroHtml(issues);
    const areas = buildAreasHtml(issues);

    html = replaceMarker(html, key, "board-progress", board.progress);
    html = replaceMarker(html, key, "board-qa", board.qa);
    html = replaceMarker(html, key, "board-done", board.done);
    html = replaceMarker(html, key, "distro-bars", distro.bars);
    html = replaceMarker(html, key, "distro-legend", distro.legend);
    html = replaceMarker(html, key, "areas", areas);

    if (cfg.milestoneId) {
      const m = await fetchMilestoneProgress(cfg.milestoneId);
      if (m) {
        const pct = Math.round((m.progress ?? 0) * 100);
        html = replaceMarker(html, key, "milestone-bar", `<div style="width:${pct}%"></div>`);
        html = replaceMarker(html, key, "milestone-count", `${pct}% concluído`);
      }
    }
  }

  writeFileSync("index.html", html);
  console.log("index.html atualizado com os dados do Linear.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
