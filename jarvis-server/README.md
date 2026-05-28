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
Retorna `{"status":"ok"}`. Use para health check e para manter o servidor acordado (UptimeRobot, cron-job.org).

### `POST /alexa`
Recebe o webhook da Alexa Skill, extrai o texto falado, consulta o ChatGPT com o system prompt do Jarvis e retorna a resposta no formato Alexa.

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

**Resposta:**
```json
{
  "version": "1.0",
  "response": {
    "outputSpeech": { "type": "PlainText", "text": "Luz da sala ligada." },
    "shouldEndSession": false
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

**Resposta:**
```json
{ "success": true, "result": { ... } }
```

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `OPENAI_API_KEY` | Chave da API da OpenAI |
| `HA_URL` | URL base do Home Assistant (ex: `http://192.168.1.100:8123`) |
| `HA_TOKEN` | Token de longa duração do Home Assistant |
| `PORT` | Porta do servidor (Render define automaticamente) |

## Como configurar e deployar no Render

### 1. Pré-requisitos
- Conta no [Render](https://render.com) (plano gratuito funciona)
- Chave da OpenAI: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- Token do Home Assistant: **Perfil → Segurança → Tokens de acesso de longa duração**

### 2. Deploy no Render

1. Faça fork ou clone deste repositório no GitHub
2. No Render, clique em **New → Web Service**
3. Conecte seu repositório GitHub
4. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Em **Environment Variables**, adicione:
   ```
   OPENAI_API_KEY = sk-...
   HA_URL         = http://SEU_IP_DO_HA:8123
   HA_TOKEN       = seu_token_aqui
   ```
6. Clique em **Create Web Service**

O Render vai gerar uma URL pública como `https://jarvis-server-xxxx.onrender.com`.

### 3. Manter o servidor acordado (plano gratuito)

O plano gratuito do Render hiberna após 15 minutos de inatividade. Para evitar:

- Cadastre a URL `https://seu-servidor.onrender.com/ping` no [UptimeRobot](https://uptimerobot.com) com intervalo de **5 minutos** (gratuito)
- Ou use o [cron-job.org](https://cron-job.org) para fazer GET `/ping` a cada 5 minutos

### 4. Configurar a Alexa Skill

1. Acesse o [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask)
2. Crie uma nova Skill do tipo **Custom**
3. Em **Endpoint**, selecione **HTTPS** e cole a URL:
   ```
   https://seu-servidor.onrender.com/alexa
   ```
4. Crie um Intent com um slot chamado `texto` do tipo `AMAZON.SearchQuery`
5. Treine e publique a Skill

## Executar localmente

```bash
# Instalar dependências
npm install

# Criar arquivo .env baseado no exemplo
cp .env.example .env
# edite o .env com suas credenciais

# Iniciar em modo desenvolvimento
npm run dev

# Iniciar em produção
npm start
```

## Estrutura do projeto

```
jarvis-server/
├── index.js        # Servidor principal
├── package.json
├── .env.example    # Modelo de variáveis de ambiente
├── .gitignore
└── README.md
```
