require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const AUDIO_DIR = path.join(__dirname, 'public', 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

app.use('/audio', express.static(AUDIO_DIR));

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

async function gerarAudio(texto) {
  if (!ELEVENLABS_API_KEY) {
    process.stdout.write('ElevenLabs: API key não configurada\n');
    return null;
  }

  process.stdout.write(`ElevenLabs: gerando audio para "${texto}"\n`);
  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        text: texto,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      },
      {
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        responseType: 'arraybuffer',
      }
    );

    const id = crypto.randomUUID();
    const rawPath = path.join(AUDIO_DIR, `${id}-raw.mp3`);
    const filename = `${id}.mp3`;
    const filepath = path.join(AUDIO_DIR, filename);
    fs.writeFileSync(rawPath, response.data);

    // Alexa exige MP3 a 48 kbps, 24 kHz, mono. Transcoda com ffmpeg.
    await new Promise((resolve, reject) => {
      execFile(
        'ffmpeg',
        ['-y', '-i', rawPath, '-ac', '1', '-ar', '24000', '-b:a', '48k', '-codec:a', 'libmp3lame', filepath],
        (err, stdout, stderr) => {
          fs.unlink(rawPath, () => {});
          if (err) {
            process.stdout.write(`ffmpeg ERRO: ${stderr || err.message}\n`);
            return reject(err);
          }
          resolve();
        }
      );
    });

    setTimeout(() => fs.unlink(filepath, () => {}), 300000);

    process.stdout.write(`ElevenLabs: audio gerado: ${PUBLIC_URL}/audio/${filename}\n`);
    return `${PUBLIC_URL}/audio/${filename}`;
  } catch (err) {
    process.stdout.write(`ElevenLabs ERRO: ${err.message}\n`);
    return null;
  }
}

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

app.get('/ping', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/alexa', async (req, res) => {
  try {
    const body = req.body;
    const requestType = body?.request?.type;

    // Usuário abriu a skill sem falar nada
    if (requestType === 'LaunchRequest') {
      const audioUrl = await gerarAudio('Olá, sou o Nero. Como posso ajudar?');
      if (audioUrl) return res.json(alexaAudioResponse(audioUrl, 'Olá, sou o Nero. Como posso ajudar?'));
      return res.json(alexaResponse('Olá, sou o Nero. Como posso ajudar?'));
    }

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

    let response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 300,
    });

    let assistantMessage = response.choices[0].message;

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

      response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 150,
      });

      assistantMessage = response.choices[0].message;
    }

    const reply = assistantMessage.content?.trim() || 'Feito.';
    const audioUrl = await gerarAudio(reply);

    if (audioUrl) {
      return res.json(alexaAudioResponse(audioUrl, reply));
    }

    return res.json(alexaResponse(reply));
  } catch (err) {
    console.error('Erro no /alexa:', err.message);
    return res.json(alexaResponse('Ocorreu um erro ao processar sua solicitação.'));
  }
});

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

function alexaAudioResponse(audioUrl, fallbackText) {
  return {
    version: '1.0',
    response: {
      outputSpeech: {
        type: 'SSML',
        ssml: `<speak><audio src="${audioUrl}"/></speak>`,
      },
      card: {
        type: 'Simple',
        title: 'Jarvis',
        content: fallbackText,
      },
      shouldEndSession: false,
    },
  };
}

app.listen(PORT, () => {
  console.log(`Jarvis server rodando na porta ${PORT}`);
});
