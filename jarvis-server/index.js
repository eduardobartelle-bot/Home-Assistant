require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;

// Ferramentas que o GPT pode chamar
const tools = [
  {
    type: 'function',
    function: {
      name: 'controlar_home_assistant',
      description:
        'Executa um comando no Home Assistant. Use para ligar/desligar luzes, controlar temperatura, verificar sensores, acionar cenas e qualquer outro dispositivo doméstico.',
      parameters: {
        type: 'object',
        properties: {
          endpoint: {
            type: 'string',
            description:
              'Endpoint da API REST do Home Assistant. Exemplos: "services/light/turn_on", "services/light/turn_off", "services/switch/toggle", "services/climate/set_temperature", "states/light.sala"',
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST'],
            description: 'Método HTTP. Use GET para consultar estado, POST para executar ação.',
          },
          data: {
            type: 'object',
            description:
              'Dados do comando. Exemplos: {"entity_id": "light.sala"} ou {"entity_id": "climate.quarto", "temperature": 22}',
          },
        },
        required: ['endpoint', 'method'],
      },
    },
  },
];

// Chama o Home Assistant
async function chamarHomeAssistant(endpoint, method, data) {
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

  return response.data;
}

// GET /ping - health check
app.get('/ping', (req, res) => {
  res.json({ status: 'ok' });
});

// POST /alexa - recebe webhook da Alexa Skill
app.post('/alexa', async (req, res) => {
  try {
    const body = req.body;

    const userText =
      body?.request?.intent?.slots?.texto?.value ||
      body?.request?.intent?.slots?.query?.value ||
      body?.request?.intent?.slots?.command?.value ||
      '';

    if (!userText) {
      return res.json(alexaResponse('Não entendi o que você disse. Pode repetir?'));
    }

    const messages = [
      {
        role: 'system',
        content:
          'Você é Jarvis, assistente doméstico inteligente. Responda de forma curta e direta. ' +
          'Quando o usuário pedir para controlar algum dispositivo da casa, use a função controlar_home_assistant. ' +
          'Após executar um comando, confirme brevemente o que foi feito.',
      },
      { role: 'user', content: userText },
    ];

    // Primeira chamada — GPT decide se usa function ou responde direto
    let response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 300,
    });

    let assistantMessage = response.choices[0].message;

    // GPT quer chamar o Home Assistant
    if (assistantMessage.tool_calls?.length > 0) {
      messages.push(assistantMessage);

      for (const toolCall of assistantMessage.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);
        let resultado;

        try {
          resultado = await chamarHomeAssistant(args.endpoint, args.method, args.data);
        } catch (err) {
          resultado = { erro: err.message };
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(resultado),
        });
      }

      // Segunda chamada — GPT formula a resposta final com o resultado do HA
      response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 150,
      });

      assistantMessage = response.choices[0].message;
    }

    const reply = assistantMessage.content?.trim() || 'Feito.';
    return res.json(alexaResponse(reply));
  } catch (err) {
    console.error('Erro no /alexa:', err.message);
    return res.json(alexaResponse('Ocorreu um erro ao processar sua solicitação.'));
  }
});

// POST /home - repassa comandos diretos pro Home Assistant
app.post('/home', async (req, res) => {
  try {
    const { endpoint, method = 'POST', data } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Campo "endpoint" é obrigatório.' });
    }

    const resultado = await chamarHomeAssistant(endpoint, method, data);
    return res.json({ success: true, result: resultado });
  } catch (err) {
    console.error('Erro no /home:', err.message);
    const status = err.response?.status || 500;
    return res.status(status).json({ error: err.message });
  }
});

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
