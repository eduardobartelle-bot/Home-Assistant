require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

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

const SYSTEM_PROMPT =
  'Você é Nero, um assistente doméstico inteligente e amigável. ' +
  'Responda de forma curta, natural e direta, como numa conversa por voz. ' +
  'Você lembra do contexto da conversa: se o usuário disser "apaga ela" logo após falar de uma luz, ' +
  'entenda a que dispositivo ele se refere a partir das mensagens anteriores. ' +
  'Quando o usuário pedir para controlar algum dispositivo da casa, use a função controlar_home_assistant. ' +
  'Após executar um comando, confirme brevemente o que foi feito.';

// ---------- Memória de conversa (Supabase, com fallback em memória local) ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MAX_MENSAGENS = 20; // mantém as últimas 10 trocas (usuário + assistente)

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
    realtime: { enabled: false },
  });
  process.stdout.write('Memória: Supabase conectado\n');
} else {
  process.stdout.write('Memória: Supabase não configurado, usando memória local (some ao reiniciar)\n');
}

const memoriaLocal = new Map();

async function carregarHistorico(userId) {
  if (!userId) return [];
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('conversas')
        .select('mensagens')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      return data?.mensagens || [];
    } catch (err) {
      process.stdout.write(`Memória ERRO (carregar): ${err.message}\n`);
      return [];
    }
  }
  return memoriaLocal.get(userId) || [];
}

async function salvarHistorico(userId, mensagens) {
  if (!userId) return;
  const recorte = mensagens.slice(-MAX_MENSAGENS);
  if (supabase) {
    try {
      const { error } = await supabase
        .from('conversas')
        .upsert({ user_id: userId, mensagens: recorte, atualizado_em: new Date().toISOString() });
      if (error) throw error;
    } catch (err) {
      process.stdout.write(`Memória ERRO (salvar): ${err.message}\n`);
    }
  } else {
    memoriaLocal.set(userId, recorte);
  }
}

// ---------- Ferramenta de controle do Home Assistant ----------
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

// ---------- Geração de voz (ElevenLabs + transcodificação pro formato Alexa) ----------
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

// ---------- Conversa com o GPT (com memória + function calling) ----------
async function conversarComGPT(userId, userText) {
  const historico = await carregarHistorico(userId);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...historico,
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

  // Salva apenas as trocas de texto (sem os detalhes internos das tool calls).
  const novoHistorico = [
    ...historico,
    { role: 'user', content: userText },
    { role: 'assistant', content: reply },
  ];
  await salvarHistorico(userId, novoHistorico);

  return reply;
}

// ---------- Endpoints ----------
app.get('/ping', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/alexa', async (req, res) => {
  try {
    const body = req.body;
    const requestType = body?.request?.type;
    const userId = body?.session?.user?.userId || 'anon';

    // Sessão encerrada pelo Alexa (silêncio, erro etc.)
    if (requestType === 'SessionEndedRequest') {
      return res.json({ version: '1.0', response: {} });
    }

    // Usuário abriu a skill ("Alexa, abrir nero home")
    if (requestType === 'LaunchRequest') {
      return res.json(await responder('Olá, sou o Nero. Como posso ajudar?', false));
    }

    if (requestType === 'IntentRequest') {
      const intentName = body?.request?.intent?.name;

      // Encerrar conversa
      if (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent') {
        return res.json(await responder('Até logo!', true));
      }

      // Ajuda
      if (intentName === 'AMAZON.HelpIntent') {
        return res.json(
          await responder('Pode me pedir para controlar a casa ou conversar sobre qualquer assunto. O que deseja?', false)
        );
      }

      const userText =
        body?.request?.intent?.slots?.query?.value ||
        body?.request?.intent?.slots?.texto?.value ||
        body?.request?.intent?.slots?.command?.value ||
        '';

      // FallbackIntent ou fala não reconhecida: pede pra repetir mas mantém a sessão aberta
      if (!userText) {
        return res.json(await responder('Não entendi. Pode repetir?', false));
      }

      const reply = await conversarComGPT(userId, userText);
      return res.json(await responder(reply, false));
    }

    return res.json(await responder('Não entendi. Pode repetir?', false));
  } catch (err) {
    console.error('Erro no /alexa:', err.message);
    return res.json(alexaResponse('Ocorreu um erro ao processar sua solicitação.', false));
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

// ---------- Montagem das respostas Alexa ----------
async function responder(text, endSession) {
  const audioUrl = await gerarAudio(text);
  if (audioUrl) return alexaAudioResponse(audioUrl, text, endSession);
  return alexaResponse(text, endSession);
}

function alexaResponse(text, endSession = false) {
  return {
    version: '1.0',
    response: {
      outputSpeech: {
        type: 'PlainText',
        text,
      },
      shouldEndSession: endSession,
    },
  };
}

function alexaAudioResponse(audioUrl, fallbackText, endSession = false) {
  return {
    version: '1.0',
    response: {
      outputSpeech: {
        type: 'SSML',
        ssml: `<speak><audio src="${audioUrl}"/></speak>`,
      },
      card: {
        type: 'Simple',
        title: 'Nero',
        content: fallbackText,
      },
      shouldEndSession: endSession,
    },
  };
}

app.listen(PORT, () => {
  console.log(`Jarvis server rodando na porta ${PORT}`);
});
