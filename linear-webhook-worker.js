/**
 * Cloudflare Worker — recebe o webhook do Linear e aciona o rebuild do site no GitHub.
 *
 * O que ele faz:
 *  1. Recebe o POST que o Linear envia a cada evento (issue criada, movida de raia,
 *     label alterada, etc.)
 *  2. Confere a assinatura (header "linear-signature") usando o segredo configurado
 *     no Linear na hora de criar o webhook — evita que qualquer um chame essa URL.
 *  3. Dispara um "repository_dispatch" no GitHub, que aciona a Action
 *     ".github/workflows/update-cockpit.yml" — essa Action busca os dados novos no
 *     Linear e republica o site.
 *
 * Deploy (resumo — detalhes completos em SETUP-tempo-real.md):
 *  1. Crie uma conta gratuita em https://workers.cloudflare.com (se ainda não tiver).
 *  2. `npm install -g wrangler` e `wrangler login`.
 *  3. `wrangler deploy linear-webhook-worker.js --name dux-cockpit-webhook`
 *  4. Configure os segredos do Worker:
 *       wrangler secret put LINEAR_WEBHOOK_SECRET
 *       wrangler secret put GITHUB_TOKEN
 *       wrangler secret put GITHUB_REPO      # ex: "lucashenning/dux-cockpit"
 *  5. Pegue a URL que o `wrangler deploy` devolve (algo como
 *     https://dux-cockpit-webhook.<subdomínio>.workers.dev) e cadastre no Linear em
 *     Workspace Settings → API → Webhooks, apontando para essa URL.
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Método não suportado — este endpoint só aceita o webhook do Linear.", { status: 405 });
    }

    const rawBody = await request.text();

    // 1) Confere a assinatura HMAC-SHA256 que o Linear envia no header.
    const signatureHeader = request.headers.get("linear-signature") || "";
    const isValid = await verifySignature(rawBody, signatureHeader, env.LINEAR_WEBHOOK_SECRET);
    if (!isValid) {
      return new Response("Assinatura inválida.", { status: 401 });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (err) {
      return new Response("JSON inválido.", { status: 400 });
    }

    // 2) Só nos interessam eventos de Issue (criação, atualização — inclui mudança de
    //    raia/status, label, assignee) e de Project (para pegar progresso de Milestone).
    const relevantTypes = ["Issue", "Project", "ProjectMilestone"];
    if (!relevantTypes.includes(payload.type)) {
      return new Response("Ignorado (tipo de evento não relevante).", { status: 200 });
    }

    // 3) Aciona o GitHub Action via repository_dispatch.
    const ghResponse = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "dux-cockpit-webhook",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "linear-update",
        client_payload: {
          linearEventType: payload.type,
          linearAction: payload.action,
          issueId: payload.data && payload.data.identifier,
        },
      }),
    });

    if (!ghResponse.ok) {
      const errText = await ghResponse.text();
      return new Response(`Erro ao acionar o GitHub Action: ${errText}`, { status: 502 });
    }

    return new Response("OK — rebuild do cockpit acionado.", { status: 202 });
  },
};

async function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const computedHex = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(computedHex, signatureHeader);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
