# openrouter-proxy-worker

A small Cloudflare Worker that keeps an LLM API key on the server side for a mobile app, so the key never ships in the app binary. Built as a working demo of the pattern: one Worker, several AI features, shared auth and forwarding, per-feature model config.

Live demo: https://my-first-worker.ivan01march.workers.dev/ — open it in a browser for the route list; `/dexa` and `/food` describe each feature in the browser too. POST (the actual model call) needs the app token.

## What it does

- `GET /` — service description, deployed version, routes
- `GET /dexa`, `GET /food` — feature description: models, key handling, privacy flag, request shape (no model call)
- `POST /dexa` — explains a DEXA (bone density) report from a photo or text
- `POST /food` — estimates a meal's nutrition from a photo or description
- Every request must carry `x-app-token` (401 otherwise); unknown feature → 404
- OpenRouter key comes from Wrangler secrets (`env.OPENROUTER_KEY`), never from the client
- Provider privacy flag is set in the request body (`provider.data_collection: "deny"`), not in a dashboard setting
- Per-feature model list with fallback on 404 / 429 / 5xx (free-tier models have rate limits); text-only models are skipped when the request contains an image
- Every response carries `x-worker-version` (git commit at deploy) and `x-model` (which model actually answered), so one request shows what is deployed and what handled it

Models are OpenRouter free-tier (`thinkingmachines/inkling-small:free`, `dots-studio/dots-3-note-preview:free`, `nvidia/nemotron-3.5-lightning:free`) — answers are illustrative; the proxy pattern is the point.

## Request body

Short form (handy for curl):

```json
{ "text": "T-score -2.6 at the lumbar spine, Z-score -1.8. What does it mean?", "image": "data:image/jpeg;base64,..." }
```

Full form — OpenAI-style `messages`, images as `image_url` parts with a data: URL:

```json
{ "messages": [{ "role": "user", "content": [{ "type": "text", "text": "..." }, { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }] }] }
```

Response:

```json
{ "feature": "dexa", "model": "thinkingmachines/inkling-small:free", "answer": "...", "usage": { ... }, "fallbacks_tried": [] }
```

## Try it

```bash
BASE=https://my-first-worker.ivan01march.workers.dev
TOKEN=...   # the app token

curl -i $BASE/                                     # 200, route list, x-worker-version
curl -i $BASE/food                                 # 200, feature description (also fine in a browser)
curl -i -X POST $BASE/food                         # 401 without token
curl -i -X POST $BASE/nope -H "x-app-token: $TOKEN"   # 404, known features listed

curl -X POST $BASE/dexa -H "x-app-token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"T-score -2.6 at the lumbar spine, Z-score -1.8. What does it mean?"}'

curl -X POST $BASE/food -H "x-app-token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"A bowl of oatmeal with a banana and a glass of milk"}'

# with a photo
IMG="data:image/jpeg;base64,$(base64 -w0 meal.jpg)"
curl -X POST $BASE/food -H "x-app-token: $TOKEN" -H "Content-Type: application/json" \
  -d "{\"text\":\"Estimate this meal\",\"image\":\"$IMG\"}"
```

## Run locally

```bash
npm install
# .dev.vars (git-ignored):
#   OPENROUTER_KEY=sk-or-...
#   APP_TOKEN=...
npx wrangler dev          # http://localhost:8787
```

## Deploy

```bash
npx wrangler secret put OPENROUTER_KEY
npx wrangler secret put APP_TOKEN
npx wrangler deploy --var VERSION:$(git rev-parse --short HEAD)
```

`x-worker-version` in the response should match the latest commit in this repository.

## Adding a feature

Add an entry to `FEATURES` in `src/index.ts`: models (first is primary, the rest are fallbacks), system prompt, token limit. Auth, routing, key handling, privacy flag and headers are shared — nothing else changes.

## License

MIT
