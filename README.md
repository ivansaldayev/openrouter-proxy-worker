# openrouter-proxy-worker

A small Cloudflare Worker that keeps an LLM API key on the server side for a mobile app, so the key never ships in the app binary. Built as a working demo of the pattern: one Worker, several AI features, shared auth and forwarding, per-feature model config with fallbacks.

Live demo: https://openrouter-proxy-worker.ivan01march.workers.dev/ — open it in a browser for the route list; `/dexa` and `/food` describe each feature in the browser too. POST (the actual model call) needs the app token.

## What it does

- `GET /` — service description, deployed version, routes
- `GET /dexa`, `GET /food` — feature description: models, key handling, privacy flag, request shape (no model call)
- `POST /dexa` — explains a DEXA (bone density) report from a photo or text
- `POST /food` — estimates a meal's nutrition from a photo or description
- Every POST must carry `x-app-token` (401 otherwise); unknown feature → 404; body over 6 MB → 413
- OpenRouter key comes from Wrangler secrets (`env.OPENROUTER_KEY`), never from the client
- Provider privacy flag is set in the request body (`provider.data_collection: "deny"`), not in a dashboard setting
- Per-feature model list with fallback on 402/403/404/429/5xx, timeouts, non-JSON bodies, empty or truncated answers; text-only models are skipped when the request contains an image
- The system prompt is owned by the Worker: `system` messages from the client are dropped
- Every response carries `x-worker-version` (git commit at deploy); responses from a model also carry `x-model`, and `fallbacks_tried` lists what was skipped and why

Models are OpenRouter free tier (`dots-studio/dots-3-note-preview:free` for text and images, `nvidia/nemotron-3.5-lightning:free` text-only fallback). Answers are illustrative and take 3–8 s — the proxy pattern is the point, and an app should show a progress indicator.

## Request body

Short form (handy for curl):

```json
{ "text": "T-score -2.6 at the lumbar spine, Z-score -1.8. What does it mean?", "image": "data:image/jpeg;base64,..." }
```

`text` or `image` is required; with an image alone a default prompt is used.

Full form — OpenAI-style `messages` (`user`/`assistant` only), images as `image_url` parts with a data: URL:

```json
{ "messages": [{ "role": "user", "content": [{ "type": "text", "text": "..." }, { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }] }] }
```

Response:

```json
{ "feature": "food", "model": "dots-studio/dots-3-note-preview:free", "answer": "...", "finish_reason": "stop", "usage": { ... }, "fallbacks_tried": [] }
```

## Try it

```bash
BASE=https://openrouter-proxy-worker.ivan01march.workers.dev
TOKEN=...   # the app token

curl -i $BASE/                                        # 200, route list, x-worker-version
curl -i $BASE/food                                    # 200, feature description (also fine in a browser)
curl -i -X POST $BASE/food                            # 401 without token
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
cp .dev.vars.example .dev.vars   # then fill OPENROUTER_KEY and APP_TOKEN (git-ignored)
npx wrangler dev                 # http://localhost:8787
npm test                         # routing, auth and validation — no network
```

## Deploy

```bash
npx wrangler secret put OPENROUTER_KEY
npx wrangler secret put APP_TOKEN
npm run deploy                   # = wrangler deploy --var VERSION:<short git sha>
```

`x-worker-version` in the response matches the latest commit in this repository.

## Adding a feature

Add an entry to `FEATURES` in `src/index.ts`: models (first is primary, the rest are fallbacks), system prompt, token limit. Auth, routing, key handling, privacy flag, fallbacks and headers are shared — nothing else changes.

## What this is not

A shared app token is a gate, not authentication: anything shipped in a mobile binary can be extracted. For production, the next steps are per-user tokens issued by your backend, platform attestation (App Attest / Play Integrity) and a Cloudflare rate-limiting binding. There is no CORS on purpose — the intended client is a native app; browser calls need an `OPTIONS` handler and `Access-Control-*` headers.

## License

MIT
