# Jarvis Server

Servidor intermediário Node.js que conecta **Alexa**, **ChatGPT** e **Home Assistant**.

## Como funciona

```
Alexa Skill → POST /alexa → ChatGPT → resposta de voz
ChatGPT / automação → POST /home → Home Assistant
Cron / UptimeRobot → GET /ping → mantém servidor vivo
```

## Endpoints

### `GET /ping`
Retorna `{"status":"ok"}`. Use para health check e para manter o servidor acordado.

### `POST /alexa`
Recebe o webhook da Alexa Skill, extrai o texto falado, consulta o ChatGPT e retorna a resposta no formato Alexa.

**Body esperado (enviado automaticamente pela Alexa):**
```json
{
  "request": {
    "intent": {
      "slots": {
        "texto": { "value": "ligue a luz da sala" }
      }
    }
  }
}
```

### `POST /home`
Repassa comandos para o Home Assistant via REST API.

**Body:**
```json
{
  "endpoint": "services/light/turn_on",
  "method": "POST",
  "data": { "entity_id": "light.sala" }
}
```

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `OPENAI_API_KEY` | Chave da API da OpenAI |
| `HA_TOKEN` | Token de longa duração do Home Assistant |
| `TZ` | Fuso horário (padrão: `America/Sao_Paulo`) |
| `PORT` | Porta do jarvis-server (apenas sem Docker; padrão: `3000`) |

> Com `docker-compose`, `HA_URL` é definido automaticamente como `http://homeassistant:8123` — não precisa configurar.

---

## Opção 1 — Docker Compose (local ou VPS)

### Pré-requisitos
- Docker e Docker Compose instalados

### Subir tudo com um comando

```bash
# Clone o repositório
git clone https://github.com/seu-usuario/jarvis-server.git
cd jarvis-server

# Configure as variáveis
cp .env.example .env
# Edite o .env com OPENAI_API_KEY e HA_TOKEN

# Suba os dois serviços
docker compose up -d
```

Acesse o Home Assistant em `http://localhost:8123` e finalize o onboarding para gerar o **token de longa duração**.  
Depois adicione o token no `.env` e reinicie:

```bash
docker compose restart jarvis
```

### Parar / remover

```bash
docker compose down        # para os containers
docker compose down -v     # para e apaga o volume do HA (cuidado!)
```

### Volume persistente

Os dados do Home Assistant ficam no volume Docker `ha_config`.  
Para fazer backup:

```bash
docker run --rm \
  -v jarvis-server_ha_config:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/ha_backup.tar.gz /data
```

---

## Opção 2 — Deploy no Railway

O Railway detecta o `railway.toml` e faz o deploy via `Dockerfile` automaticamente.  
O plano gratuito dá **$5 de crédito/mês** — suficiente para rodar o jarvis-server 24/7.

### Passo a passo

#### 2.1 Jarvis Server no Railway

1. Acesse [railway.app](https://railway.app) e faça login com o GitHub
2. Clique em **New Project → Deploy from GitHub repo**
3. Selecione este repositório
4. O Railway detecta o `Dockerfile` automaticamente e inicia o build
5. Vá em **Variables** e adicione:
   ```
   OPENAI_API_KEY = sk-...
   HA_URL         = https://seu-homeassistant.duckdns.org
   HA_TOKEN       = seu_token_aqui
   ```
6. Vá em **Settings → Networking → Generate Domain** para obter a URL pública

#### 2.2 Home Assistant no Railway

1. No mesmo projeto, clique em **New → Empty Service**
2. Em **Source**, use a imagem:
   ```
   ghcr.io/home-assistant/home-assistant:stable
   ```
3. Em **Variables**, adicione:
   ```
   TZ = America/Sao_Paulo
   ```
4. Em **Settings → Networking**, exponha a porta `8123` e gere um domínio público
5. Acesse o domínio público, finalize o onboarding e gere o token de longa duração
6. Copie o token e adicione como `HA_TOKEN` nas variáveis do serviço `jarvis`
7. Em `HA_URL` do jarvis, use a URL interna do Railway (sem expor publicamente):
   - Railway conecta serviços do mesmo projeto via variável de referência:
   ```
   HA_URL = http://${{homeassistant.RAILWAY_PRIVATE_DOMAIN}}:8123
   ```

#### 2.3 Volume persistente para o HA

1. No serviço do Home Assistant, vá em **Settings → Volumes**
2. Clique em **Add Volume**
3. Mount path: `/config`
4. O Railway persiste os dados entre deploys automaticamente

---

## Opção 3 — Node.js direto (sem Docker)

```bash
npm install
cp .env.example .env
# edite o .env com todas as variáveis, incluindo HA_URL

npm start          # produção
npm run dev        # desenvolvimento com hot-reload
```

---

## Configurar a Alexa Skill

1. Acesse o [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask)
2. Crie uma nova Skill do tipo **Custom**
3. Em **Endpoint**, selecione **HTTPS** e cole:
   ```
   https://seu-servidor.up.railway.app/alexa
   ```
4. Crie um Intent com um slot chamado `texto` do tipo `AMAZON.SearchQuery`
5. Treine e publique a Skill

---

## Estrutura do projeto

```
jarvis-server/
├── index.js            # Servidor principal
├── Dockerfile          # Imagem do jarvis-server
├── docker-compose.yml  # Sobe jarvis + Home Assistant juntos (local/VPS)
├── railway.toml        # Configuração de deploy no Railway
├── package.json
├── .env.example
├── .gitignore
└── README.md
```
