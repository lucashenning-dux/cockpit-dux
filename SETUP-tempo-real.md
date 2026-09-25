# Cockpit DUX — tempo real via GitHub Pages + webhook do Linear

Este pacote contém tudo que é necessário para o cockpit ganhar um endereço fixo
(GitHub Pages), atualizar sozinho quando algo mudar no Linear, e fechar a semana
sozinho toda sexta — tudo rodando no GitHub, sem depender de nenhuma sessão do
Claude ficar "no ar" esperando.

⚠️ **Por que este pacote vem como zip pra você subir, e não já publicado por mim:**
tentei dar `git push` direto usando o token que você me passou e o próprio
ambiente onde eu rodo bloqueou (é uma trava de segurança do meu lado, o token e
o repositório estão certos). Então esse é o fluxo: eu preparo tudo pronto, você
sobe uma vez (upload no site do GitHub ou `git push` local), e a partir daí as
duas Actions abaixo cuidam de tudo sozinhas — nem eu nem você precisam mexer de
novo depois disso.

## O que tem aqui

- `index.html` — o cockpit em si, pronto para ser publicado como página estática.
  Tem marcadores HTML (`<!-- LIVE:... -->`) nos pontos que o robô vai atualizar
  sozinho (colunas do board, barra de distribuição, Áreas envolvidas, progresso
  dos Marcos). O resto (Objetivo, Próximo goal, Blockers, KPIs manuais) só muda
  quando o Lucas confirmar com o Claude — igual já funciona hoje.
- `.github/workflows/update-cockpit.yml` — a Action que atualiza o painel ao vivo
  (webhook do Linear).
- `.github/workflows/weekly-closing.yml` — a Action que fecha a semana sozinha,
  toda sexta às 18h (BRT), sem precisar de mim rodando naquele momento.
- `scripts/rebuild-board.mjs` — busca os dados no Linear e regenera o board ao vivo.
- `scripts/weekly-closing.mjs` — calcula o burndown e as métricas da semana (sem
  IA nenhuma nessa parte, é tudo conta determinística), chama a API da Anthropic
  só pra redigir os destaques/sugestões em tópicos a partir desses números, e
  congela a semana no histórico do `index.html` + em `HISTORICO.md`.
- `linear-webhook-worker.js` — o Cloudflare Worker que recebe o aviso do Linear e
  aciona a Action de atualização ao vivo.

## Passo a passo

### 1. Repositório no GitHub

1. Crie um repositório **novo e vazio** no GitHub (pode ser privado ou público —
   privado funciona com GitHub Pages também, desde que o plano do GitHub permita).
2. Suba os arquivos deste pacote pra raiz do repositório (mantendo a pasta
   `.github/workflows/` e `scripts/`).
3. Em **Settings → Pages**, em "Source" escolha a branch `main` (pasta `/`).
   O GitHub vai te dar uma URL fixa do tipo
   `https://<seu-usuario>.github.io/<nome-do-repo>/`.
4. Em **Settings → Actions → General → Workflow permissions**, marque
   **"Read and write permissions"** — sem isso a Action não consegue commitar
   as atualizações automáticas.
5. Em **Settings → Secrets and variables → Actions → New repository secret**,
   crie:
   - `LINEAR_API_KEY` — uma API key pessoal do Linear
     (Linear → Settings → Security & access → Personal API keys).
   - `ANTHROPIC_API_KEY` — uma chave da API da Anthropic (console.anthropic.com →
     Settings → API Keys), usada só pelo fechamento de sexta, só para redigir os
     tópicos de destaques/sugestões (os números em si são sempre calculados no
     próprio script, não pela IA).

### 2. Token para o Claude usar

Pra eu conseguir publicar as atualizações que faço manualmente (e o fechamento
de sexta), preciso de um **Personal Access Token (fine-grained)** com acesso
só a esse repositório:

1. GitHub → Settings (da sua conta) → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token.
2. Repository access: **só esse repositório** do cockpit.
3. Permissions: **Contents → Read and write** (nada mais precisa).
4. Defina uma expiração (90 dias é um bom padrão — dá pra renovar depois).
5. Me passe o token e o nome do repositório (`usuario/repo`) por aqui.

### 3. Cloudflare Worker (recebe o webhook do Linear)

1. Crie uma conta gratuita em https://workers.cloudflare.com, se ainda não tiver.
2. Localmente (ou peça pra eu rodar, se você preferir): `npm install -g wrangler`
   e `wrangler login`.
3. `wrangler deploy linear-webhook-worker.js --name dux-cockpit-webhook`
4. Configure os 3 segredos do Worker:
   ```
   wrangler secret put LINEAR_WEBHOOK_SECRET   # você escolhe uma senha forte qualquer
   wrangler secret put GITHUB_TOKEN            # um token com escopo "repo" (classic) ou
                                                # fine-grained com Contents + Actions:write
   wrangler secret put GITHUB_REPO             # ex: usuario/dux-cockpit
   ```
5. O `wrangler deploy` te devolve uma URL tipo
   `https://dux-cockpit-webhook.<algo>.workers.dev` — guarde ela.

### 4. Cadastrar o webhook no Linear

1. Linear → Workspace Settings → API → Webhooks → New webhook.
2. URL: a URL do Worker (passo anterior).
3. Secret: a mesma senha que você colocou em `LINEAR_WEBHOOK_SECRET`.
4. Eventos: marque pelo menos **Issues** e **Projects** (isso cobre criação,
   mudança de raia/status, labels e progresso de Marco).

Pronto — a partir daqui, qualquer mudança relevante no Linear aciona a Action,
que busca os dados novos e republica o `index.html` no ar em menos de um minuto.
Como rede de segurança, a Action também roda sozinha a cada hora, caso algum
webhook se perca no caminho.

## O que NÃO está automatizado aqui (de propósito)

- Objetivo / Próximo goal / Blockers / KPIs manuais / status "Em Construção" do
  Anti Cedente — continuam só mudando quando o Lucas confirmar com o Claude
  (em uma conversa normal, pedindo pra atualizar).
- A pergunta "tem mais alguma atualização antes de fechar a semana?" também
  fica de fora do fechamento automático — o `weekly-closing.yml` só fecha com
  o que já estiver no Linear e no `index.html` naquele momento. Se quiser
  revisar Objetivo/Blockers/KPIs antes do fechamento de sexta, é só falar com o
  Claude durante a semana, antes das 18h de sexta.

## Testando antes de confiar 100%

Depois de configurar os secrets, rode as duas Actions manualmente uma vez
(aba **Actions** do repo → escolha a Action → **Run workflow**) pra conferir se
o `index.html` fica do jeito esperado, antes de deixar rodando sozinho.
