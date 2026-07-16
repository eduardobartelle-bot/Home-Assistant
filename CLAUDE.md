# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Nero" — a voice-driven home assistant. A single Node.js/Express server (`jarvis-server/index.js`, the entire application) sits between an Alexa custom skill, OpenAI GPT, and two smart-home backends (Home Assistant REST API and Tuya Cloud IR). User speech arrives via the Alexa webhook, GPT interprets it (with function calling to actually control devices), and the reply is spoken back through ElevenLabs TTS. Comments, prompts, and user-facing strings are in Portuguese (pt-BR) — keep them that way.

## Commands

All work happens inside `jarvis-server/`:

```bash
cd jarvis-server
npm install
cp .env.example .env   # fill in keys (OpenAI required; others degrade gracefully)
npm start              # production (node index.js)
npm run dev            # hot-reload via nodemon
```

Docker Compose (runs jarvis + a Home Assistant container together): `docker compose up -d` from `jarvis-server/`.

There are no tests and no linter configured.

Deploy is on Railway via the **root** `railway.toml` (points at `jarvis-server/Dockerfile`; there is a second, near-identical `railway.toml` inside `jarvis-server/` for deploying that directory standalone). Pushing to `main` triggers the Railway build. Health check is `GET /ping`. The Dockerfile installs `ffmpeg` — required at runtime for audio transcoding.

## Architecture (all in jarvis-server/index.js)

Request flow for a voice command:

1. **`POST /alexa`** receives the Alexa skill webhook. The interaction model (`alexa-interaction-model.json`) funnels any free speech into a single `ComandoIntent` with an `AMAZON.SearchQuery` slot named `query`. Free-flowing conversation (no wake word between turns) is achieved by every non-final response attaching a `Dialog.ElicitSlot` directive (`elicitDirective()`) that reopens the mic straight into that slot. If you change slot names, update both the interaction model and the slot lookup in the `/alexa` handler.
2. **`conversarComGPT()`** loads per-user history, calls `gpt-4o-mini` with two tools, executes any tool calls, then makes a second GPT call for the final wording. Replies are hard-capped at `LIMITE_CARACTERES` (400) with a "Quer que eu continue?" continuation pattern enforced both in the system prompt and by a post-hoc trim.
3. **Device control tools:**
   - `controlar_home_assistant` → `chamarHomeAssistant()`: generic proxy to the Home Assistant REST API (`HA_URL` + `HA_TOKEN`). Also exposed directly as `POST /home`.
   - `controlar_tuya` → `controlarTuya()`: IR control of TV and A/C through a Tuya IR blaster. TV commands go through `TV_KEY_MAP` (friendly name → real Tuya `key_name`) and **must** resolve a `key_id` from the remote's key list — Tuya silently accepts commands without `key_id` but fires nothing. The A/C uses a different endpoint shape (`code` + `value` instead of keys). `GET /tuya/keys/:dispositivo` is the diagnostic endpoint to inspect the real keys registered on a remote.
   - Tuya auth is manual HMAC-SHA256 request signing (`getTuyaToken()` / `tuyaRequest()`) against `openapi.tuyaus.com` — the signing string format is exact; be careful editing it.
4. **Voice output — `gerarAudio()`**: ElevenLabs TTS, then ffmpeg transcodes to the format Alexa requires (MP3, 48 kbps, 24 kHz, mono). Files are served from `/audio` under `PUBLIC_URL` and auto-deleted after 5 minutes. If ElevenLabs is unconfigured or fails, responses fall back to Alexa's own PlainText voice — every feature here degrades gracefully rather than erroring.
5. **Conversation memory**: Supabase `conversas` table (schema in `supabase-setup.sql`, upsert via `Prefer: resolution=merge-duplicates`) keyed by Alexa `userId`, falling back to an in-process `Map` when `SUPABASE_URL`/`SUPABASE_KEY` are absent. Only plain user/assistant text turns are persisted (tool-call internals are stripped), trimmed to the last 20 messages.

## Environment variables

See `jarvis-server/.env.example` for the full list. Only `OPENAI_API_KEY` is strictly required; `HA_URL`/`HA_TOKEN` (Home Assistant), `ELEVENLABS_*` (voice), `SUPABASE_*` (memory), and `TUYA_*` (client credentials + device IDs, which have hardcoded defaults in `index.js`) each enable their feature independently. `PUBLIC_URL` must be the externally reachable URL or Alexa can't fetch the generated MP3s.
