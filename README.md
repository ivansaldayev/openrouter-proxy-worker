# openrouter-proxy-worker

A small Cloudflare Worker that keeps an LLM API key on the server side for a mobile app, so the key never ships in the app binary. Built as a working demo of the pattern: one Worker, several AI features, shared auth and forwarding, per-feature model config with fallbacks.

Live demo: https://openrouter-proxy-worker.ivan01march.workers.dev/ — open it in a browser for the route list; `/dexa` and `/food` describe each feature in the browser too. POST (the actual model call) needs the app token.

## What it does

- `GET /` — service description, deployed version, routes
- `GET /dexa`, `GET /food` — feature description: models, key handling, privacy flag, request shape (no model call)
- `HEAD` on any of the above mirrors the `GET` status and headers with no body, for uptime checks
- `POST /dexa` — explains a DEXA (bone density) report from a photo or text
- `POST /food` — estimates a meal's nutrition from a photo or description
- Every POST must carry `x-app-token` (401 otherwise); unknown feature → 404; body over 6 MB → 413
- OpenRouter key comes from Wrangler secrets (`env.OPENROUTER_KEY`), never from the client
- Provider privacy flag is set in the request body (`provider.data_collection: "deny"`), not in a dashboard setting
- Per-feature model list with fallback on any upstream error (a retired model id answers 400, not 404), timeouts, non-JSON bodies, empty or truncated answers; text-only models are skipped when the request contains an image
- The system prompt is owned by the Worker: `system` messages from the client are dropped, and a `messages` array left empty by that is a 400 rather than a call with no user turn
- Malformed `messages` (unknown role, non-string content, unknown content part) are rejected with 400 instead of being forwarded
- Every response carries `x-worker-version` (git commit at deploy); responses from a model also carry `x-model`, and `fallbacks_tried` lists what was skipped and why

Models are OpenRouter free tier (`dots-studio/dots-3-note-preview:free` for text and images, `nvidia/nemotron-3.5-lightning:free` text-only fallback). Answers are illustrative and slow: measured sequentially on the live Worker, `/food` takes 4–5 s and `/dexa` 8–10 s, and parallel requests have been seen at 15 s. The proxy pattern is the point, and an app must show a progress indicator.

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

## Example answer

Real response from the deployed Worker for the `POST /dexa` call above, captured on version `3efc145` (758 completion tokens, 8.3 s):

```
HTTP/2 200
x-worker-version: 3efc145
x-feature: dexa
x-model: dots-studio/dots-3-note-preview:free
```

```json
{
  "feature": "dexa",
  "model": "dots-studio/dots-3-note-preview:free",
  "answer": "\n\nOf course. Here is a plain-language explanation of your DEXA scan results.\n\n### Understanding Your Scores …",
  "finish_reason": "stop",
  "usage": { "prompt_tokens": 128, "completion_tokens": 758, "total_tokens": 886, "cost": 0 },
  "fallbacks_tried": []
}
```

The Worker returns the model's text byte for byte, so `answer` keeps the two leading newlines and the "Of course." opening the model likes to add. The system prompt asks it not to; free-tier models ignore that often enough that an app should not rely on the first line.

<details>
<summary>The <code>answer</code> field, rendered</summary>

Of course. Here is a plain-language explanation of your DEXA scan results.

### Understanding Your Scores

Your report provides two key numbers:

*   **T-score: -2.6 at the lumbar spine**
*   **Z-score: -1.8**

#### What is the T-score?
The T-score compares your bone density to that of a healthy 30-year-old adult, which represents peak bone density.

*   **-2.6** means your bone density is 2.6 standard deviations below the average for a young adult.
*   According to the World Health Organization (WHO) thresholds, this value falls into the **osteoporosis** range. The categories are:
    *   **Normal:** T-score of -1.0 or higher
    *   **Osteopenia (low bone mass):** T-score between -1.0 and -2.5
    *   **Osteoporosis:** T-score of -2.5 or lower

#### What is the Z-score?
The Z-score compares your bone density to others of the same age, sex, and body size.

*   **-1.8** means your bone density is 1.8 standard deviations below the average for someone your age.
*   This score generally falls within the **expected range for age**. A Z-score below -2.0 can sometimes prompt a search for secondary causes of bone loss, but -1.8 is close to that threshold.

### Putting It Together

The difference between your T-score and Z-score is informative. Your Z-score suggests that having a lower bone density is not entirely unexpected for someone your age. However, the T-score indicates that the result has crossed into the osteoporosis category, which signifies a higher risk for fractures.

### Questions to Ask Your Doctor

It's very appropriate to discuss these results with your doctor. Sensible questions include:

1.  "Based on my T-score of -2.6, what is my personal risk for a fracture?"
2.  "Can we discuss lifestyle changes I can make right now to support my bone health, such as diet and exercise?"
3.  "Are there any other health conditions or medications I'm taking that could be affecting my bone density?"
4.  "What is your recommendation for monitoring my bone density in the future? Should we do another scan in a year or two?"

This information is for educational purposes only and is not a substitute for professional medical advice. Please discuss your specific results and health plan with your doctor.

</details>

### Fallback, live

Verified by temporarily putting a bogus model first in `FEATURES.food`:

```json
{
  "feature": "food",
  "model": "dots-studio/dots-3-note-preview:free",
  "answer": "…",
  "fallbacks_tried": [
    { "model": "test/nonexistent:free", "status": 400, "reason": "upstream error", "detail": "test/nonexistent:free is not a valid model ID", "ms": 176 }
  ]
}
```

The client gets a normal 200 from the next model, and `fallbacks_tried` says what was skipped and why. Only an exhausted candidate list is a 502.

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill OPENROUTER_KEY and APP_TOKEN (git-ignored)
npx wrangler dev                 # http://localhost:8787
npm test                         # routing, auth and validation — no network
npm run check                    # tsc over src and test
```

## Deploy

```bash
npx wrangler secret put OPENROUTER_KEY
npx wrangler secret put APP_TOKEN
npm run deploy                   # scripts/deploy.mjs: wrangler deploy --var VERSION:<short git sha>, any shell
```

`x-worker-version` in the response matches the latest commit in this repository.

## Adding a feature

Add an entry to `FEATURES` in `src/index.ts`: models (first is primary, the rest are fallbacks), system prompt, token limit. Auth, routing, key handling, privacy flag, fallbacks and headers are shared — nothing else changes.

## What this is not

A shared app token is a gate, not authentication: anything shipped in a mobile binary can be extracted. For production, the next steps are per-user tokens issued by your backend, platform attestation (App Attest / Play Integrity) and a Cloudflare rate-limiting binding. There is no CORS on purpose — the intended client is a native app; browser calls need an `OPTIONS` handler and `Access-Control-*` headers.

## How this was built

Written with Claude Code (Claude Opus 5) in a pair-programming loop: the commits carry a `Co-Authored-By` trailer, and each round of review findings was applied, deployed and then re-checked against the live URL. The review notes that drove the last two rounds are not in the repository; the resulting behaviour is covered by the tests and by the curl commands above.

## License

MIT
