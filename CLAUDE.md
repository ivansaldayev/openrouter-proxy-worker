# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Cloudflare Worker that proxies OpenRouter so an LLM API key never ships inside a mobile app binary. It is a demo of the pattern, not a product: one Worker, several AI features, shared auth/forwarding/fallbacks, per-feature model config. Deployed at `https://openrouter-proxy-worker.ivan01march.workers.dev`.

## Commands

```bash
npm test                       # vitest, 14 tests, no network
npx vitest run -t "HEAD"       # single test or describe block by name
npm run check                  # tsc --noEmit over BOTH tsconfigs (src and test)
npm run dev                    # wrangler dev on http://localhost:8787
npm run deploy                 # wrangler deploy --var VERSION:$(git rev-parse --short HEAD)
npx prettier --write src test  # 2-space indent, single quotes, 140 cols
```

`npm run check` must run both projects: the root `tsconfig.json` has `"exclude": ["test"]`, so a single `tsc --noEmit` silently skips every type error in `test/`.

## Architecture

Everything lives in `src/index.ts` — a single default-exported `fetch` handler. There is no router library and no per-feature file.

`FEATURES` is the one table that drives the whole Worker: each key is both the URL path and the feature name, and its value carries the model list, system prompt and token budget. Adding a feature means adding one entry; auth, routing, fallbacks, privacy flag and headers are shared and need no change.

Request flow: path → `Object.hasOwn(FEATURES, feature)` lookup → GET/HEAD serve JSON self-description without calling a model → POST checks `x-app-token`, then the feature, then body size and shape → the model loop.

The model loop walks `cfg.models` in order and treats these as "try the next model": HTTP 402/403/404/429/5xx, fetch timeout (25 s), a non-JSON upstream body, an empty answer, and `finish_reason === 'length'`. Every skipped attempt is recorded in `fallbacks_tried`, which is returned to the client. The Worker never answers 200 with an empty `answer`. Upstream 400/401 is deliberately not forwarded as-is — it returns 502 instead, so the app cannot confuse "my token is wrong" with "the Worker's key is wrong".

Invariants worth preserving:

- `Object.hasOwn` guards the feature lookup. Plain `FEATURES[feature]` returns `Object.prototype` members, which made `/constructor` and `/__proto__` throw 500.
- HEAD is answered like GET through `withoutBody()`, mirroring status and headers with no body.
- The system prompt belongs to the Worker: `toMessages()` drops any `role: 'system'` message sent by the client.
- `TEXT_ONLY` models are filtered out when the request carries an image.
- The model's text is returned verbatim: never trimmed, stripped or rewritten. A non-string `content` counts as empty and falls through to the next model.

## Deploy invariant

`x-worker-version` and `body.version` must equal `git rev-parse --short HEAD`; the README promises this. `npm run deploy` passes it via `--var`, so **deploy after committing**, and redeploy after any commit that changes what is served — including README-only commits, or the live version silently falls behind.

Verify a deploy against the live URL, not just via unit tests:

```bash
BASE=https://openrouter-proxy-worker.ivan01march.workers.dev
TOKEN=$(grep '^APP_TOKEN=' .dev.vars | cut -d= -f2-)
curl -s $BASE/ | head -5                                   # version must match HEAD
curl -s -o /dev/null -w '%{http_code}\n' $BASE/__proto__   # 404, not 500
curl -X POST $BASE/dexa -H "x-app-token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"T-score -2.6 at the lumbar spine, Z-score -1.8. What does it mean?"}'
```

Note `curl -I` sends HEAD, so it is the wrong tool for checking a GET response's headers — use `curl -D - -o /dev/null -X GET`.

## Secrets and config

`.dev.vars` (git-ignored) holds `OPENROUTER_KEY`, `APP_TOKEN`, `VERSION` for `wrangler dev`; `.dev.vars.example` is the committed template. Production secrets live in Cloudflare per Worker and are set separately — the current production `APP_TOKEN` matches the local one. Do not upload `.dev.vars` wholesale: its `VERSION` would become a secret and collide with the `--var VERSION` passed at deploy.

```bash
grep -E '^(OPENROUTER_KEY|APP_TOKEN)=' .dev.vars | npx wrangler secret bulk
```

The workers.dev hostname comes from `name` in `wrangler.jsonc`, not the directory name (which is still `my-first-worker`). Changing `name` creates a *new* Worker with empty secrets rather than renaming the old one.

## Models

Free-tier OpenRouter: `dots-studio/dots-3-note-preview:free` (text + images) with `nvidia/nemotron-3.5-lightning:free` (text-only) as fallback. `thinkingmachines/inkling-small:free` is listed by the API but gated to "agentic harnesses" and returns 403 — do not add it back.

Reasoning models burn the whole token budget before answering unless `reasoning: { effort: 'low', exclude: true }` is sent — keep it.

These models also like to open with "Of course. Here is…" regardless of the system prompt. A regex that stripped that opener used to live here; it was removed because it mangled real answers (`Here is your T-score: -2.6` lost its number). Do not reintroduce string surgery on model output — if the preamble matters, fix it in the prompt or leave it.

## Conventions

Prettier config is authoritative: 2 spaces, single quotes, semicolons, 140 columns. Comments in `src/` are in English and explain *why*, not what. Tests are network-free and cover routing, auth and validation; live model calls are checked by hand with curl after a deploy.

Import `env` from `cloudflare:workers` in tests — the `cloudflare:test` export of the same name is deprecated, as is `SELF`.

Commits on this repo carry a `Co-Authored-By: Claude Opus 5 (1M context)` trailer.
