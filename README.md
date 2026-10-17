# Abyss Proxy — Node.js para Render.com

Proxy CORS para `abysscdn.com` que bypassa o bloqueio de fingerprint TLS do edge do `workers.dev` no Cloudflare. Usa **curl como backend de fetch** (Node native fetch/https.request têm fingerprint TLS diferente de curl e são bloqueados pelo Cloudflare de abysscdn.com).

## Por que isso é necessário

O worker `abyss-proxy.ognoses.workers.dev` retornava **403 + "Just a moment..."** para o Roku (confirmado pelo log da v201). Isso é o edge do Cloudflare bloqueando o fingerprint TLS do Roku — não há código BrightScript que resolva.

O Render.com **não tem essa proteção de edge**, então o Roku consegue chamar este servidor Node diretamente. E o servidor por sua vez usa **curl** (que tem fingerprint TLS aceito pelo Cloudflare de abysscdn.com) para fazer o fetch.

## Estrutura

```
abyss-proxy-render/
├── server.js         # HTTP server Node.js com endpoints /fetch e /?seg0=...
├── package.json      # Node.js config
└── README.md         # este arquivo
```

## Passo a passo para deploy no Render.com (FREE TIER)

### Passo 1: Criar repositório GitHub

1. Faça login no GitHub (https://github.com)
2. Crie um novo repositório **público**, ex: `abyss-proxy-render`
   - Marque "Add a README file" (opcional)
3. Suba os 2 arquivos (`server.js` e `package.json`) para o repositório
   - Web UI: clique "Add file" → "Upload files" → arrasta os 2 arquivos → "Commit changes"

### Passo 2: Criar conta no Render.com (se não tiver)

1. Acesse https://render.com
2. Clique "Get Started" / "Sign Up"
3. Faça login com GitHub (botão "GitHub") — autoriza o Render a ver seus repositórios

### Passo 3: Criar Web Service

1. No dashboard do Render (https://dashboard.render.com), clique **New +** → **Web Service**
2. Selecione o repositório `abyss-proxy-render` que você acabou de criar
3. Preencha:
   - **Name**: `abyss-proxy` (ou o nome que preferir — vai fazer parte da URL final)
   - **Region**: escolha a mais próxima do Brasil (Frankfurt ou Ohio se São Paulo não disponível)
   - **Runtime**: `Node` (auto-detectado do package.json)
   - **Branch**: `main` (ou `master`)
   - **Build Command**: `npm install` (Render detecta automaticamente)
   - **Start Command**: `npm start` (Render detecta automaticamente)
   - **Instance Type**: `Free` (gratuito, suficiente para teste)
4. Clique **Create Web Service** no fundo

### Passo 4: Aguardar build & deploy (~1-3 min)

Você verá logs ao vivo no dashboard. Quando aparecer:

```
==> Your service is live 🎉
==> Available at https://abyss-proxy-xxxx.onrender.com
```

O deploy está pronto. **Anote essa URL** (`https://abyss-proxy-xxxx.onrender.com`).

### Passo 5: Testar com curl do seu computador

No terminal:

```bash
# Test 1: Health check
curl https://abyss-proxy-xxxx.onrender.com/
# Deve retornar: "Abyss CDN Proxy v1-render OK..."

# Test 2: CORS proxy — buscar a página do abysscdn.com
curl -s -o /tmp/test.html -w "HTTP=%{http_code} LEN=%{size_download}\n" \
  "https://abyss-proxy-xxxx.onrender.com/fetch?url=https%3A%2F%2Fabysscdn.com%2F%3Fv%3D01gE05Adb"

# Deve retornar: HTTP=200 LEN=~11000
grep -c 'const datas\|eyJzbHVn' /tmp/test.html
# Deve retornar: 1  (encontrou a variável datas!)
```

Se `datas_found: 1`, o proxy está funcionando perfeitamente.

### Passo 6: Atualizar constantes no app Roku

Edite `components/FetchTask.brs` no projeto do Roku:

**Linha ~3128** (page fetch, dentro de `tryAbyssExtraction`):
```brightscript
ABYSS_PAGE_WORKER_BASE_URL = "https://abyss-proxy-xxxx.onrender.com"
```

**Linha ~4084** (video range stitching, procure por `WORKER_PROXY_URL = `):
```brightscript
WORKER_PROXY_URL = "https://abyss-proxy-xxxx.onrender.com/"
```

Salve o arquivo. Reempacote o zip do projeto Roku.

### Passo 7: Side-load e testar no Roku

Side-load a nova versão e dê play no Velozes & Furiosos 7. No log você deve ver:

```
[FetchTask] Abyss: tentando via worker /fetch proxy (cached): https://abyss-proxy-xxxx.onrender.com/fetch?url=...
[FetchTask] fetchHtml: https://abyss-proxy-xxxx.onrender.com/fetch?url=...
[FetchTask] HTML recebido:  11240 status= 200          <-- SUCESSO!
[FetchTask] Abyss: worker proxy retornou 11240 bytes
[FetchTask] Abyss: datas encontrado via worker-proxy length= 2624
[FetchTask] Abyss: datas raw bytes= 1910
[FetchTask] Abyss: player config: slug=01gE05Adb md5_id=25798545 user_id=9133
[FetchTask] Abyss: media decrypt OK ...
[FetchTask] Abyss: segment URL: https://...
```

Se `HTML recebido: 11240 status= 200` aparecer, **o path ABYS está desbloqueado**.

## Notas sobre Free Tier

- **Cold start**: o free tier "spin down" após 15 min de inatividade (cold start ~50s na próxima request)
- **Runtime**: 750h/mês (suficiente para uso contínuo)
- **Bandwidth**: 100GB/mês (mais que suficiente para streaming de alguns filmes)
- Para uso intenso, considere o plano Starter ($7/mês) — sem cold start

## Endpoints implementados

| Endpoint | Função |
|----------|---------|
| `GET /` | Health check |
| `GET /fetch?url=<URL>` | CORS proxy genérico (via curl) |
| `GET /?seg0=<URL>&seg1=<URL>&frag=N&total=M` | Video range stitching (concatena 2 segments para >512MB) |
| `GET /debug?seg0=<URL>&frag=N&total=M` | Teste de conectividade com a origem |
| `GET /logs` | Log das últimas 30 requests |

## Troubleshooting

### Build falha com "No package.json found"
- Verifique que o `package.json` está na raiz do repositório (não em subpasta)
- Verifique que o commit foi feito no branch `main` ou `master`

### Deploy succeed mas /fetch retorna 500 "curl not found"
- Render's runtime Node deve ter curl pré-instalado (Debian/Ubuntu base)
- Se não tiver, adicione um `render.yaml` ou use um Dockerfile customizado

### Roku ainda recebe 403
- Teste `https://abyss-proxy-xxxx.onrender.com/fetch?url=https%3A%2F%2Fabysscdn.com%2F%3Fv%3D01gE05Adb` no browser do seu computador
- Se aparecer HTML com "Velozes & Furiosos 7 (2015).mp4", o proxy funciona — me mande o log atualizado do roku

### Cold start lento (~50s)
- Normal no free tier. Para evitar:
  - Plano pago Starter ($7/mês)
  - Ou um "ping" automático a cada 10 min via cron-job.org (gratuito) que chama a URL de health check

### Erro "502 Bad Gateway" ao chamar /fetch
- Verifique em `/logs` se a request chegou
- Pode ser timeout fetchando a origem (abysscdn.com é lento às vezes) — aguarde ou tente novamente

## Alternativa: outros hosts

O mesmo código funciona em:

- **Railway.app** — Free tier $5/mês de crédito, sem cold start, mais estável que Render free
- **fly.io** — Free tier generoso, deploy via CLI
- **Heroku** — Eco dynos (gratuitos mas limitados)
- **Vercel** — Serverless functions, mas tem timeout de 10s no plano gratuito (não serve para range stitching)

Basta ajustar o `start` script em `package.json` para `node server.js` e apontar a variável `PORT` (todos esses hosts injetam `PORT` automaticamente).

## Como funciona (resumo técnico)

1. Roku chama `https://abyss-proxy-xxxx.onrender.com/fetch?url=<abyss_url>`
2. Render.com (sem edge protection do workers.dev) recebe a request do Roku
3. Node server chama `curl <abyss_url>` com browser-like headers
4. curl tem fingerprint TLS aceito pelo Cloudflare de abysscdn.com → 200 OK com a página
5. Node server retorna a página ao Roku com headers CORS

O Roku não consegue chamar abysscdn.com direto (CF edge bloqueia fingerprint TLS roku). O Render.com não bloqueia o Roku. E curl não é bloqueado pelo CF de abysscdn.com. Composição funciona.
