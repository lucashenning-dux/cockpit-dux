// Fechamento semanal do Cockpit DUX — roda inteiramente no GitHub Actions
// (sexta 18h BRT / 21h UTC), sem depender de nenhuma sessão do Claude.
//
// O que faz:
//  1. Busca no Linear as issues dos 3 projetos com createdAt/completedAt/labels/assignee.
//  2. Calcula, de forma 100% determinística (sem IA): burndown diário (seg-sex),
//     total de atualizações, quebra por área (Marketing/Financeiro/Outros),
//     quem mais entregou, e quais blockers da semana passada continuam aparecendo.
//  3. Chama a API da Anthropic APENAS para escrever, em tópicos curtos, os
//     "destaques" e "sugestões" a partir desses números já calculados — a IA não
//     inventa nem recalcula nada, só redige.
//  4. Desenha o burndown em SVG (paleta validada pela skill de dataviz do Claude:
//     references/palette.md, ordem categórica fixa, sem dual-axis).
//  5. Congela a semana atual no `WEEK_HISTORY` embutido no index.html, avança a
//     semana corrente para a segunda seguinte, e grava também um resumo em
//     HISTORICO.md (texto simples, fácil de ler depois de meses).
//
// Secrets necessários no repo (Settings → Secrets and variables → Actions):
//   LINEAR_API_KEY, ANTHROPIC_API_KEY
// Variável opcional: ANTHROPIC_MODEL (default abaixo) — ajuste se o modelo mudar.
//
// ATENÇÃO: assim como o rebuild-board.mjs, os nomes de campo GraphQL do Linear
// aqui seguem a doc pública e não foram testados contra o workspace real — rode
// uma vez manualmente (workflow_dispatch) e confira antes de confiar 100%.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";

const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

if (!LINEAR_API_KEY || !ANTHROPIC_API_KEY) {
  console.error("Faltou LINEAR_API_KEY e/ou ANTHROPIC_API_KEY no ambiente.");
  process.exit(1);
}

const PROJECTS = [
  { key: "anti-banking", label: "Anti Banking", projectId: "47c55255-de0a-45c0-9919-04e1f2132355" },
  { key: "anti-sacado", label: "Anti Sacado", projectId: "37062b7b-23d9-4724-af18-54bbe6b8720d" },
  { key: "decentral", label: "Decentral", projectId: "c070788d-b8fe-4acf-a8c7-b3f137d132ed" },
];

// Paleta categórica validada (dataviz skill, references/palette.md) — ordem fixa,
// nunca ciclada. 4 séries (Total + 3 projetos) num line chart usam o gate
// "adjacent", que os 8 slots na ordem abaixo já cobrem.
const SERIES_COLORS = {
  total: "#2a78d6",       // slot 1 — blue
  "anti-banking": "#eb6834", // slot 2 — orange
  "anti-sacado": "#1baf7a",  // slot 3 — aqua
  decentral: "#eda100",      // slot 4 — yellow
};

function mondayOf(date) {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0=domingo
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function fmtLabel(monday, friday) {
  const meses = ["JAN","FEV","MAR","ABR","MAI","JUN","JUL","AGO","SET","OUT","NOV","DEZ"];
  return `${String(monday.getUTCDate()).padStart(2,"0")} — ${String(friday.getUTCDate()).padStart(2,"0")} ${meses[friday.getUTCMonth()]} ${friday.getUTCFullYear()}`;
}

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

function areaOf(issue) {
  const labels = issue.labels.nodes.map((l) => l.name);
  if (labels.includes("Marketing")) return "Marketing";
  if (labels.includes("Financeiro")) return "Financeiro";
  return "Outros";
}

function isOpenOnDay(issue, day) {
  const created = new Date(issue.createdAt);
  const completed = issue.completedAt ? new Date(issue.completedAt) : null;
  const endOfDay = new Date(day);
  endOfDay.setUTCHours(23, 59, 59, 999);
  return created <= endOfDay && (!completed || completed > endOfDay);
}

function buildBurndownSvg(days, series) {
  // series: [{key, label, color, values:number[]}]  — 1 ponto por dia
  const W = 560, H = 220, padL = 34, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i) => padL + (i / (days.length - 1)) * plotW;
  const y = (v) => padT + plotH - (v / maxV) * plotH;

  const gridLines = [0, 0.5, 1].map((f) => {
    const yy = padT + plotH * (1 - f);
    return `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="var(--closing-grid,#D9E1DE)" stroke-width="1" />`;
  }).join("");

  const dayLabels = days.map((d, i) =>
    `<text x="${x(i).toFixed(1)}" y="${H - 6}" font-size="10" text-anchor="middle" fill="var(--closing-axis,#8B9997)" font-family="IBM Plex Mono, monospace">${["SEG","TER","QUA","QUI","SEX"][i]}</text>`
  ).join("");

  const lines = series.map((s) => {
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const lastX = x(s.values.length - 1), lastY = y(s.values[s.values.length - 1]);
    return `
      <polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3" fill="${s.color}" />`;
  }).join("");

  const legend = series.map((s, i) =>
    `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:12px;"><span style="width:8px;height:8px;border-radius:50%;background:${s.color};display:inline-block;"></span>${s.label}</span>`
  ).join("");

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Burndown da semana: issues abertas por dia, por projeto">
    ${gridLines}${lines}${dayLabels}
  </svg>
  <div style="display:flex;flex-wrap:wrap;font-size:11px;color:var(--ink-soft,#57666B);margin-top:6px;">${legend}</div>`;
}

async function askClaudeForNarrative(stats) {
  const prompt = `Você recebe números já calculados (não invente nem recalcule nada) sobre a semana de operação de 3 times de produto (Anti Banking, Anti Sacado, Decentral) no Linear. Escreva um JSON estrito, sem markdown, no formato:
{"highlights": ["...", "..."], "suggestions": ["...", "..."]}
Regras: 3 a 5 destaques, 2 a 4 sugestões. Cada item é um tópico curto (máximo ~18 palavras), sem frases de efeito, direto ao ponto, em português. Destaques = o que mudou/aconteceu de mais relevante nos números. Sugestões = como amadurecer o processo, baseadas nos gargalos que os números mostram (áreas mais lentas, blockers persistentes). A análise é dos 3 projetos em conjunto.

Dados da semana:
${JSON.stringify(stats, null, 2)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  const text = json.content?.[0]?.text || "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch ? jsonMatch[0] : text);
}

async function main() {
  const today = new Date();
  const monday = mondayOf(today);
  const friday = new Date(monday);
  friday.setUTCDate(monday.getUTCDate() + 4);
  friday.setUTCHours(23, 59, 59, 999);

  const days = [0, 1, 2, 3, 4].map((i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return d;
  });

  let html = readFileSync("index.html", "utf8");
  const dataMatch = html.match(/<script id="weekHistoryData" type="application\/json">([\s\S]*?)<\/script>/);
  let stateData = { history: [], currentWeek: null };
  if (dataMatch) {
    try { stateData = JSON.parse(dataMatch[1]); } catch (e) { /* mantém default */ }
  }
  const prevWeek = stateData.history[stateData.history.length - 1];
  const prevBlockerIds = new Set(
    (prevWeek?.blockers || []).map((b) => b.id)
  );

  const perProject = {};
  const aggregateByDay = days.map(() => 0);
  let totalCreated = 0, totalCompleted = 0;
  const areaStats = { Marketing: { created: 0, completed: 0 }, Financeiro: { created: 0, completed: 0 }, Outros: { created: 0, completed: 0 } };
  const deliverers = {}; // nome -> count

  for (const proj of PROJECTS) {
    const issues = await fetchProjectIssues(proj.projectId);

    const createdInWeek = issues.filter((i) => new Date(i.createdAt) >= monday && new Date(i.createdAt) <= friday);
    const completedInWeek = issues.filter((i) => i.completedAt && new Date(i.completedAt) >= monday && new Date(i.completedAt) <= friday);
    totalCreated += createdInWeek.length;
    totalCompleted += completedInWeek.length;

    for (const i of createdInWeek) areaStats[areaOf(i)].created++;
    for (const i of completedInWeek) {
      areaStats[areaOf(i)].completed++;
      const name = i.assignee?.name || "Sem responsável";
      deliverers[name] = (deliverers[name] || 0) + 1;
    }

    const dailyOpen = days.map((day) => issues.filter((i) => isOpenOnDay(i, day)).length);
    dailyOpen.forEach((v, idx) => { aggregateByDay[idx] += v; });

    perProject[proj.key] = { label: proj.label, dailyOpen, createdCount: createdInWeek.length, completedCount: completedInWeek.length };
  }

  const burndownSvg = buildBurndownSvg(days, [
    { key: "total", label: "Total (3 projetos)", color: SERIES_COLORS.total, values: aggregateByDay },
    ...PROJECTS.map((p) => ({ key: p.key, label: p.label, color: SERIES_COLORS[p.key], values: perProject[p.key].dailyOpen })),
  ]);

  const topDeliverers = Object.entries(deliverers).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));
  const slowestArea = Object.entries(areaStats).sort((a, b) => (b[1].created - b[1].completed) - (a[1].created - a[1].completed))[0];

  const stats = {
    semana: `${monday.toISOString().slice(0,10)} a ${friday.toISOString().slice(0,10)}`,
    totalAtualizacoes: totalCreated + totalCompleted,
    issuesCriadas: totalCreated,
    issuesConcluidas: totalCompleted,
    porArea: areaStats,
    areaComMaisAcumulo: slowestArea ? slowestArea[0] : null,
    topEntregadores: topDeliverers,
    porProjeto: Object.fromEntries(Object.entries(perProject).map(([k, v]) => [k, { criadas: v.createdCount, concluidas: v.completedCount }])),
  };

  const narrative = await askClaudeForNarrative(stats);

  const newEntry = {
    label: fmtLabel(monday, friday),
    start: monday.toISOString().slice(0, 10),
    end: friday.toISOString().slice(0, 10),
    closedAt: new Date().toISOString(),
    open: false,
    report: {
      burndownSvg,
      highlights: narrative.highlights || [],
      suggestions: narrative.suggestions || [],
    },
  };

  const nextMonday = new Date(monday);
  nextMonday.setUTCDate(monday.getUTCDate() + 7);
  const nextFriday = new Date(nextMonday);
  nextFriday.setUTCDate(nextMonday.getUTCDate() + 4);

  stateData.history.push(newEntry);
  stateData.currentWeek = { label: fmtLabel(nextMonday, nextFriday), open: true };

  const newDataBlock = `<script id="weekHistoryData" type="application/json">\n${JSON.stringify(stateData.history, null, 0)}\n</script>`;
  // Nota: index.html lê hoje `weekHistoryData` como só o array de histórico e mantém
  // `currentWeek` fixo no script de render — o Action também atualiza esse literal:
  html = html.replace(/<script id="weekHistoryData" type="application\/json">[\s\S]*?<\/script>/, `<script id="weekHistoryData" type="application/json">\n${JSON.stringify(stateData.history)}\n</script>`);
  html = html.replace(/var currentWeek = \{[^}]*\};/, `var currentWeek = ${JSON.stringify(stateData.currentWeek)};`);

  writeFileSync("index.html", html);

  const histLine = `\n## Semana ${newEntry.label}\n\n- Fechado em: ${newEntry.closedAt}\n- Atualizações: ${stats.totalAtualizacoes} (${stats.issuesCriadas} criadas, ${stats.issuesConcluidas} concluídas)\n- Área com mais acúmulo: ${stats.areaComMaisAcumulo}\n- Top entregadores: ${topDeliverers.map(d => `${d.name} (${d.count})`).join(", ") || "—"}\n- Destaques:\n${(newEntry.report.highlights||[]).map(h=>`  - ${h}`).join("\n")}\n- Sugestões:\n${(newEntry.report.suggestions||[]).map(s=>`  - ${s}`).join("\n")}\n`;
  if (!existsSync("HISTORICO.md")) writeFileSync("HISTORICO.md", "# Histórico de fechamentos semanais — Cockpit DUX\n");
  appendFileSync("HISTORICO.md", histLine);

  console.log("Fechamento da semana gerado:", newEntry.label);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
