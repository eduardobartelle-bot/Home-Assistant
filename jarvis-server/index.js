require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;

// GET /ping - health check para manter o servidor acordado
app.get('/ping', (req, res) => {
  res.json({ status: 'ok' });
});

// POST /alexa - recebe webhook da Alexa Skill
app.post('/alexa', async (req, res) => {
  try {
    const body = req.body;

    // Extrai o texto falado pelo usuário da requisição da Alexa
    const userText =
      body?.request?.intent?.slots?.texto?.value ||
      body?.request?.intent?.slots?.query?.value ||
      body?.request?.intent?.slots?.command?.value ||
      '';

    if (!userText) {
      return res.json(alexaResponse('Não entendi o que você disse. Pode repetir?'));
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Você é Jarvis, assistente doméstico inteligente. Responda de forma curta e direta.',
        },
        { role: 'user', content: userText },
      ],
      max_tokens: 300,
    });

    const reply = completion.choices[0].message.content.trim();
    return res.json(alexaResponse(reply));
  } catch (err) {
    console.error('Erro no /alexa:', err.message);
    return res.json(alexaResponse('Ocorreu um erro ao processar sua solicitação.'));
  }
});

// POST /home - repassa comandos pro Home Assistant
app.post('/home', async (req, res) => {
  try {
    const { endpoint, method = 'POST', data } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Campo "endpoint" é obrigatório.' });
    }

    const haUrl = process.env.HA_URL?.replace(/\/$/, '');
    const haToken = process.env.HA_TOKEN;

    const response = await axios({
      method,
      url: `${haUrl}/api/${endpoint}`,
      headers: {
        Authorization: `Bearer ${haToken}`,
        'Content-Type': 'application/json',
      },
      data,
    });

    return res.json({ success: true, result: response.data });
  } catch (err) {
    console.error('Erro no /home:', err.message);
    const status = err.response?.status || 500;
    return res.status(status).json({ error: err.message });
  }
});

// Monta a resposta no formato esperado pela Alexa
function alexaResponse(text) {
  return {
    version: '1.0',
    response: {
      outputSpeech: {
        type: 'PlainText',
        text,
      },
      shouldEndSession: false,
    },
  };
}

app.listen(PORT, () => {
  console.log(`Jarvis server rodando na porta ${PORT}`);
});
