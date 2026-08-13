# Àdùnní — Multilingual AI Voice Agent

Production voice agent pipeline for Nigerian English, Pidgin, Yorùbá, Igbo, and Hausa with mid-conversation code-switching.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        API Gateway (:3000)                   │
│   REST + WebSocket — auth, session lifecycle, transcript     │
└──────┬──────────────────────────────────────────────────────┘
       │
  ┌────┴────┬──────────┬──────────────┬──────────────┐
  ▼         ▼          ▼              ▼              ▼
 ASR      TTS    Orchestrator   Action Exec    Config Svc
:3001    :3002      :3003          :3004          :3005
  │         │          │              │              │
  └─────────┴──────────┴──────────────┴──────────────┘
                              │
                     Session Store (:3006)
                     Postgres + Audit Trail
```

## Services

| Service | Port | Responsibility |
|---------|------|----------------|
| api-gateway | 3000 | REST API + WebSocket audio stream, JWT auth, pipeline orchestration |
| asr-service | 3001 | Speech-to-text with per-chunk language identification |
| tts-service | 3002 | Text-to-speech with streaming response in caller's language |
| orchestrator | 3003 | LLM-backed dialogue brain, intent resolution, escalation |
| action-executor | 3004 | Webhook calls to client backends, confirm-before-mutate, rate limiting |
| config-service | 3005 | Per-client config: languages, intents, escalation rules, branding |
| session-store | 3006 | Postgres persistence: sessions, turns, actions, audit trail |

## Quick Start

### Docker (recommended)
```bash
docker compose up --build
```
This starts Postgres, Redis, and all 7 services.

### Local Development
```bash
npm install
npm run db:migrate
npm run db:seed
npm run dev:local
```

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/sessions` | Start a new voice session |
| WS | `/v1/sessions/{id}/stream` | Real-time bidirectional audio stream |
| GET | `/v1/sessions/{id}/transcript` | Retrieve transcript + translations + action log |
| GET | `/v1/sessions/{id}/summary` | Session summary (turns, languages, resolution) |
| POST | `/v1/clients/{id}/config` | Set/update client config |
| GET | `/v1/clients/{id}/config` | Get client config |
| POST | `/v1/webhooks/subscribe` | Subscribe to real-time transcript/action events |

## Authentication

All REST endpoints require `Authorization: Bearer <JWT>`. JWTs are signed with `JWT_SECRET` and contain the `clientId`.

WebSocket connections authenticate via `?token=<JWT>` query parameter.

## Pilot Client

The seed creates **Savanna Bank** (`savanna-bank`) with:
- All 5 languages enabled
- 3 intents: `check_balance`, `transfer_status`, `raise_transfer_limit`
- Confirm-before-mutate on limit increases
- Escalation threshold at 0.65 confidence

## Provider Adapters

ASR, TTS, and LLM use provider-agnostic interfaces. Mock implementations are included for development. Swap with real providers by implementing the interfaces in `@adunni/shared-types`:

- `AsrProvider` — streaming speech-to-text with language ID
- `TtsProvider` — streaming text-to-speech per language
- `LlmProvider` — LLM completion with tool/function calling

## Tech Stack

- **Runtime**: Node.js 20, TypeScript 5.3
- **Framework**: Express 4
- **Database**: PostgreSQL 16
- **Realtime**: WebSocket (ws)
- **Auth**: JWT (jsonwebtoken)
- **Infra**: Docker Compose, horizontal scaling per service
