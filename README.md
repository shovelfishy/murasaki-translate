# Murasaki Translate

Real-time bilingual speech translation with room-based sessions.

Users can create or join a session, stream microphone audio, and generate transcript/translation segments using OpenAI speech + text models.

## Features

- Single-device mode (`single`)
- Multi-phone mode (`multi`) with roles:
  - `listener` (sends audio)
  - `controller` (controls recording/cut)
  - `viewer` (read-only)
- Live segmented transcript feed
- Cut handshake in multi mode so controller cuts wait for listener flush/ack
- In-session role switching

## Tech Stack

- OpenAI Node SDK (`openai`)
- Upstash Redis
- Next.js 16 (App Router)
- React 19
- TypeScript
- Tailwind CSS
- shadcn-style UI components (Button, Select)

## Prerequisites

- Node.js 18+ (recommended: latest LTS)
- An OpenAI API key

## Environment Variables

Create `.env` in project root:

```bash
OPENAI_API_KEY=your_key_here
# Optional overrides:
OPENAI_STT_MODEL=gpt-4o-mini-transcribe
OPENAI_TRANSLATION_MODEL=gpt-4o-mini
```

## Installation & Run

```bash
npm install
npm run dev
```

Open:

- Main UI: `http://localhost:3000/v1`

## How It Works

1. Create or join a session room.
2. Pick mode (`single` or `multi`) and language pair (`languageA`, `languageB`).
3. Recording sends 1-second chunks to `/api/v1/chunk`.
4. A cut combines queued chunks, transcribes, translates, and appends a segment to feed.
5. Feed polling (`/api/v1/feed`) keeps all clients synchronized.

## API Overview

All v1 server routes run in Node runtime.

- `POST /api/v1/session`
  - Multiplexed action endpoint:
    - `create`, `join`, `status`
    - `claim_role`, `release_role`, `leave`, `heartbeat`
    - `control` (`start` / `stop`)
    - `request_cut`, `ack_cut_ready`
- `POST /api/v1/chunk`
  - Upload audio chunk (`audioBase64`, `seq`, timestamps, mime type)
- `POST /api/v1/cut`
  - Finalize queued audio into one translated segment
- `GET /api/v1/feed`
  - Fetch session snapshot + new segments by cursor

## Data Model Notes

- Session state is stored **in-memory** in `globalThis.__v1Store` (`Map<string, SessionState>`).
- Data is not persisted to a database.
- A process restart clears all active sessions.
- Session TTL cleanup is currently time-based in memory.

## Available Scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## Project Structure

- `src/app/v1/page.tsx` - session setup (create/join)
- `src/app/v1/session/[code]/page.tsx` - live session UI
- `src/app/api/v1/*` - API endpoints
- `src/lib/v1/store.ts` - in-memory session/role/chunk state
- `src/lib/v1/ai.ts` - transcription + translation pipeline
