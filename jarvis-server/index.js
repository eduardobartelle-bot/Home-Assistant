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

const LIMITE_CARACTERES = 400;

const SYSTEM_PROMPT =
  'Você é Nero, um assistente doméstico inteligente e amigável. Você está sendo ouvido por voz. ' +
  `Responda em no máximo ${LIMITE_CARACTERES} caracteres. ` +
  'Se a resposta completa for mais longa que isso, responda APENAS a primeira parte (parando num ponto natural, ' +
  'como o fim de uma frase) e termine perguntando exatamente: "Quer que eu continue?". ' +
  'Se o usuário disser que sim (ou "continua", "pode continuar"), continue exatamente de onde você parou, ' +
  'sem repetir o que já foi dito, respeitando o mesmo limite de caracteres. ' +
  'Você lembra do contexto da conversa: se o usuário disser "apaga ela" logo após falar de uma luz, ' +
  'entenda a que dispositivo ele se refere a partir das mensagens anteriores. ' +
  'Quando o usuário pedir para controlar TV ou ar condicionado, use a função controlar_tuya. ' +
  'Quando o usuário pedir para controlar luzes, cenas ou outros dispositivos do Home Assistant, use controlar_home_assistant. ' +
  'Após executar um comando, confirme brevemente o que foi feito. ' +
  'Se uma ferramenta retornar erro, NUNCA diga que o comando foi executado: avise que não conseguiu e explique o motivo em palavras simples.';

// ---------- Memória de conversa (Supabase, com fallback em memória local) ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MAX_MENSAGENS = 20; // mantém as últimas 10 trocas (usuário + assistente)

const supabaseEnabled = !!(SUPABASE_URL && SUPABASE_KEY);
if (supabaseEnabled) {
  process.stdout.write('Memória: Supabase configurado\n');
} else {
  process.stdout.write('Memória: Supabase não configurado, usando memória local (some ao reiniciar)\n');
}

const memoriaLocal = new Map();

async function carregarHistorico(userId) {
  if (!userId) return [];
  if (supabaseEnabled) {
    try {
      const res = await axios.get(
        `${SUPABASE_URL}/rest/v1/conversas?user_id=eq.${encodeURIComponent(userId)}&select=mensagens`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }, timeout: 3000 }
      );
      return res.data?.[0]?.mensagens || [];
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
  if (supabaseEnabled) {
    try {
      await axios.post(
        `${SUPABASE_URL}/rest/v1/conversas`,
        { user_id: userId, mensagens: recorte, atualizado_em: new Date().toISOString() },
        {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates',
          },
          timeout: 3000,
        }
      );
    } catch (err) {
      process.stdout.write(`Memória ERRO (salvar): ${err.message}\n`);
    }
  } else {
    memoriaLocal.set(userId, recorte);
  }
}

// ---------- Tuya Cloud API ----------
const TUYA_CLIENT_ID = process.env.TUYA_CLIENT_ID;
const TUYA_CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
const TUYA_BASE_URL = 'https://openapi.tuyaus.com';

const TUYA_DEVICES = {
  tv: process.env.TUYA_DEVICE_TV || 'eb3eba3160f1409b92ni2k',
  ar: process.env.TUYA_DEVICE_AR || 'eb15d262bdb776c854n2ja',
  ir: process.env.TUYA_DEVICE_IR || 'eb6c31fc5ea6a70e2bzy6w',
};

// Mapeia comandos amigáveis (do GPT) para o key_name real da TV TCL na Tuya.
const TV_KEY_MAP = {
  power: 'power',
  volume_up: 'volume_up',
  volume_down: 'volume down',
  mute: 'mute',
  channel_up: 'channel_up',
  channel_down: 'channel_down',
  ok: 'ok',
  menu: 'menu',
  up: 'navigate_up',
  down: 'navigate_down',
  left: 'navigate_left',
  right: 'navigate_right',
  back: 'back',
  home: 'homepage',
  input: 'input',
};

let tuyaToken = null;
let tuyaTokenExpiry = 0;

// A Tuya responde HTTP 200 até quando falha (success:false) — sem esta checagem
// os erros passam batido e o GPT acha que o comando funcionou.
function verificarRespostaTuya(data) {
  if (data && data.success === false) {
    if (data.code === 28841002) {
      throw new Error(
        'A assinatura gratuita do Tuya IoT Core expirou de novo. Renove em platform.tuya.com, em Cloud, IoT Core, Extend Trial Period. É grátis e vale seis meses.'
      );
    }
    throw new Error(`A Tuya recusou o comando: ${data.msg} (código ${data.code})`);
  }
}

async function getTuyaToken() {
  if (tuyaToken && Date.now() < tuyaTokenExpiry) return tuyaToken;

  const t = Date.now().toString();
  const nonce = '';
  const contentHash = crypto.createHash('sha256').update('').digest('hex');
  const stringToSign = ['GET', contentHash, '', '/v1.0/token?grant_type=1'].join('\n');
  const str = TUYA_CLIENT_ID + t + nonce + stringToSign;
  const sign = crypto.createHmac('sha256', TUYA_CLIENT_SECRET).update(str).digest('hex').toUpperCase();

  const res = await axios.get(`${TUYA_BASE_URL}/v1.0/token?grant_type=1`, {
    headers: {
      client_id: TUYA_CLIENT_ID,
      sign,
      t,
      sign_method: 'HMAC-SHA256',
      nonce,
    },
    timeout: 5000,
  });

  process.stdout.write(`Tuya token response: ${JSON.stringify(res.data)}\n`);
  verificarRespostaTuya(res.data);
  tuyaToken = res.data.result.access_token;
  tuyaTokenExpiry = Date.now() + (res.data.result.expire_time - 60) * 1000;
  return tuyaToken;
}

async function tuyaRequest(method, path, body) {
  const token = await getTuyaToken();
  const t = Date.now().toString();
  const nonce = '';
  const bodyStr = body ? JSON.stringify(body) : '';
  const contentHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const stringToSign = [method.toUpperCase(), contentHash, '', path].join('\n');
  const str = TUYA_CLIENT_ID + token + t + nonce + stringToSign;
  const sign = crypto.createHmac('sha256', TUYA_CLIENT_SECRET).update(str).digest('hex').toUpperCase();

  const res = await axios({
    method,
    url: `${TUYA_BASE_URL}${path}`,
    headers: {
      client_id: TUYA_CLIENT_ID,
      access_token: token,
      sign,
      t,
      nonce,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json',
    },
    data: body || undefined,
    timeout: 5000,
  });
  verificarRespostaTuya(res.data);
  return res.data;
}

async function controlarTuya(dispositivo, comando, parametros) {
  const deviceId = TUYA_DEVICES[dispositivo.toLowerCase()];
  if (!deviceId) throw new Error(`Dispositivo "${dispositivo}" não encontrado. Use: tv, ar`);

  const ir = TUYA_DEVICES.ir;
  let path, body;

  if (dispositivo.toLowerCase() === 'ar') {
    // Ar condicionado: endpoint dedicado, usa code + value
    path = `/v2.0/infrareds/${ir}/air-conditioners/${deviceId}/command`;
    body = { code: comando, value: parametros ?? 1 };
  } else {
    // TV / remote padrão: usa key (+ category_id e remote_index)
    const remotesRes = await tuyaRequest('GET', `/v2.0/infrareds/${ir}/remotes`, null);
    const remote = remotesRes.result?.find(r => r.remote_id === deviceId);

    // Busca a lista de keys reais pra achar o key_id correto (sem ele a Tuya
    // aceita mas não dispara o sinal certo).
    const keysRes = await tuyaRequest('GET', `/v2.0/infrareds/${ir}/remotes/${deviceId}/keys`, null);
    const keyName = TV_KEY_MAP[comando.toLowerCase()] || comando;
    const entry = keysRes.result?.key_list?.find(
      k => k.key_name === keyName || k.key === comando || k.key_name === comando
    );

    path = `/v2.0/infrareds/${ir}/remotes/${deviceId}/command`;
    body = {
      category_id: remote?.category_id,
      remote_index: remote?.remote_index,
      key: entry?.key,
      key_id: entry?.key_id,
    };
  }

  process.stdout.write(`Tuya: ${dispositivo} → ${comando} (${JSON.stringify(body)}) path=${path}\n`);
  try {
    const result = await tuyaRequest('POST', path, body);
    process.stdout.write(`Tuya resultado: ${JSON.stringify(result)}\n`);
    return result;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    process.stdout.write(`Tuya ERRO: ${detail}\n`);
    throw err;
  }
}

// ---------- Ferramentas do GPT ----------
const tools = [
  {
    type: 'function',
    function: {
      name: 'controlar_home_assistant',
      description:
        'Executa um comando no Home Assistant. Use para ligar/desligar luzes, ativar cenas, verificar sensores e qualquer dispositivo da lista de entidades do prompt.\n' +
        'Para acionar: endpoint "services/<dominio>/<servico>" com method POST e data {"entity_id": "<id exato da lista>"}. ' +
        'Exemplos: services/switch/turn_off + {"entity_id":"switch.luz_sala_mesa"}; services/scene/turn_on + {"entity_id":"scene.modo_cinema"}; services/light/turn_on + {"entity_id":"light.x"}.\n' +
        'Para consultar estado: endpoint "states/<entity_id>" com method GET.\n' +
        'Use SEMPRE um entity_id exato da lista de entidades — nunca invente.',
      parameters: {
        type: 'object',
        properties: {
          endpoint: {
            type: 'string',
            description: 'Caminho da API REST, ex.: "services/switch/turn_off" ou "states/switch.luz_sala_mesa".',
          },
          method: { type: 'string', enum: ['GET', 'POST'] },
          data: { type: 'object', description: 'Para services: {"entity_id": "<id da lista>"}.' },
        },
        required: ['endpoint', 'method'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'controlar_tuya',
      description:
        'Controla TV e Ar Condicionado via controle infravermelho Tuya.\n' +
        'TV (dispositivo="tv") — comando deve ser uma destas KEYS: ' +
        'power, volume_up, volume_down, mute, channel_up, channel_down, ok, menu, up, down, left, right. ' +
        'Para TV não use o campo parametros.\n' +
        'AR CONDICIONADO (dispositivo="ar") — comando deve ser um destes CODES com o campo parametros: ' +
        'power (parametros: 1=liga, 0=desliga), temp (parametros: 16 a 30 graus), ' +
        'mode (parametros: 0=refrigerar, 1=aquecer, 2=automático, 3=ventilar, 4=desumidificar), ' +
        'wind (parametros: 0=auto, 1=baixa, 2=média, 3=alta).',
      parameters: {
        type: 'object',
        properties: {
          dispositivo: { type: 'string', enum: ['tv', 'ar'], description: 'Qual dispositivo controlar.' },
          comando: { type: 'string', description: 'A key (TV) ou code (AR) do comando.' },
          parametros: { type: 'number', description: 'Valor do comando (só para o ar condicionado).' },
        },
        required: ['dispositivo', 'comando'],
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
    timeout: 5000,
  });

  return response.data;
}

// ---------- Inventário de entidades pro GPT ----------
// O GPT não adivinha entity_ids: a cada conversa enviamos a lista real de
// dispositivos do Home Assistant no prompt. Cache curto pra não pesar o
// orçamento de 8s da Alexa.
const DOMINIOS_RELEVANTES = new Set([
  'light', 'switch', 'scene', 'script', 'climate', 'fan', 'cover',
  'media_player', 'lock', 'vacuum', 'todo', 'weather', 'sensor', 'binary_sensor',
]);
const ENTIDADES_CACHE_MS = 30000;
const ENTIDADES_MAX = 80;
let entidadesCache = { texto: '', expira: 0 };

async function listarEntidadesHA() {
  if (Date.now() < entidadesCache.expira) return entidadesCache.texto;
  try {
    const states = await chamarHomeAssistant('states', 'GET');
    const texto = states
      .filter(e => DOMINIOS_RELEVANTES.has(e.entity_id.split('.')[0]))
      .slice(0, ENTIDADES_MAX)
      .map(e => `${e.entity_id} | ${e.attributes?.friendly_name || ''} | ${e.state}`)
      .join('\n');
    entidadesCache = { texto, expira: Date.now() + ENTIDADES_CACHE_MS };
    return texto;
  } catch (err) {
    process.stdout.write(`HA entidades ERRO: ${err.message}\n`);
    return '';
  }
}

// ---------- Conversa com o GPT (com memória + function calling) ----------
async function conversarComGPT(userId, userText) {
  const [historico, entidades] = await Promise.all([carregarHistorico(userId), listarEntidadesHA()]);

  let systemPrompt = SYSTEM_PROMPT;
  if (entidades) {
    systemPrompt +=
      '\n\nEntidades disponíveis no Home Assistant (entity_id | nome | estado atual):\n' +
      entidades +
      '\nPara controlar, chame controlar_home_assistant com endpoint "services/<dominio>/<servico>" ' +
      '(o domínio é o prefixo do entity_id, ex.: switch → services/switch/turn_off), method "POST" ' +
      'e data {"entity_id": "<entity_id exato da lista>"}. Nunca invente entity_id fora da lista.';
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    ...historico,
    { role: 'user', content: userText },
  ];

  let response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    tools,
    tool_choice: 'auto',
    max_tokens: 220,
  });

  let assistantMessage = response.choices[0].message;

  if (assistantMessage.tool_calls?.length > 0) {
    messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      let resultado;

      try {
        if (toolCall.function.name === 'controlar_tuya') {
          resultado = await controlarTuya(args.dispositivo, args.comando, args.parametros);
        } else {
          resultado = await chamarHomeAssistant(args.endpoint, args.method, args.data);
        }
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
      max_tokens: 220,
    });

    assistantMessage = response.choices[0].message;
  }

  let reply = assistantMessage.content?.trim() || 'Feito.';

  // Corte de segurança: se passar do limite, corta num fim de frase e oferece continuar.
  if (reply.length > LIMITE_CARACTERES && !/quer que eu continue\?$/i.test(reply)) {
    const corte = reply.slice(0, LIMITE_CARACTERES);
    const ultimoPonto = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('! '), corte.lastIndexOf('? '));
    const parte = ultimoPonto > 100 ? corte.slice(0, ultimoPonto + 1) : corte;
    reply = `${parte.trim()} Quer que eu continue?`;
  }

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
      const audioUrl = await gerarAudio('Olá, sou o Nero. Como posso ajudar?');
      return res.json(alexaLaunchResponse(audioUrl, 'Olá, sou o Nero. Como posso ajudar?'));
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

// Diagnóstico: lista as keys reais cadastradas pra TV (ou outro remote).
app.get('/tuya/keys/:dispositivo', async (req, res) => {
  try {
    const disp = (req.params.dispositivo || 'tv').toLowerCase();
    const deviceId = TUYA_DEVICES[disp];
    const ir = TUYA_DEVICES.ir;
    const remotesRes = await tuyaRequest('GET', `/v2.0/infrareds/${ir}/remotes`, null);
    const remote = remotesRes.result?.find(r => r.remote_id === deviceId);
    const keysRes = await tuyaRequest('GET', `/v2.0/infrareds/${ir}/remotes/${deviceId}/keys`, null);
    return res.json({ remote, keys: keysRes.result });
  } catch (err) {
    return res.status(500).json({ error: err.message, detail: err.response?.data });
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

// Resposta do LaunchRequest: ativa o ComandoIntent com ElicitSlot já na abertura,
// assim a próxima fala do usuário (sem âncora) já vai direto pro slot "query".
function alexaLaunchResponse(audioUrl, fallbackText) {
  const speech = audioUrl
    ? { type: 'SSML', ssml: `<speak><audio src="${audioUrl}"/></speak>` }
    : { type: 'PlainText', text: fallbackText };
  return {
    version: '1.0',
    response: {
      outputSpeech: speech,
      card: { type: 'Simple', title: 'Nero', content: fallbackText },
      reprompt: { outputSpeech: { type: 'PlainText', text: 'Estou aqui. O que deseja?' } },
      directives: [
        {
          type: 'Dialog.ElicitSlot',
          slotToElicit: 'query',
          updatedIntent: {
            name: 'ComandoIntent',
            confirmationStatus: 'NONE',
            slots: { query: { name: 'query', confirmationStatus: 'NONE' } },
          },
        },
      ],
      shouldEndSession: false,
    },
  };
}

// Diretiva que reabre o microfone e captura QUALQUER fala como o slot "query",
// sem precisar de palavra-âncora. É o que permite conversa livre e contínua.
function elicitDirective() {
  return [
    {
      type: 'Dialog.ElicitSlot',
      slotToElicit: 'query',
      updatedIntent: {
        name: 'ComandoIntent',
        confirmationStatus: 'NONE',
        slots: {
          query: { name: 'query', confirmationStatus: 'NONE' },
        },
      },
    },
  ];
}

function alexaResponse(text, endSession = false) {
  const response = {
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text },
      shouldEndSession: endSession,
    },
  };
  if (!endSession) {
    response.response.directives = elicitDirective();
    response.response.reprompt = { outputSpeech: { type: 'PlainText', text: 'Ainda estou aqui. O que deseja?' } };
  }
  return response;
}

function alexaAudioResponse(audioUrl, fallbackText, endSession = false) {
  const response = {
    version: '1.0',
    response: {
      outputSpeech: {
        type: 'SSML',
        ssml: `<speak><audio src="${audioUrl}"/></speak>`,
      },
      card: { type: 'Simple', title: 'Nero', content: fallbackText },
      shouldEndSession: endSession,
    },
  };
  if (!endSession) {
    response.response.directives = elicitDirective();
    response.response.reprompt = { outputSpeech: { type: 'PlainText', text: 'Ainda estou aqui. O que deseja?' } };
  }
  return response;
}

app.listen(PORT, () => {
  console.log(`Jarvis server rodando na porta ${PORT}`);
});
