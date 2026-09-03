// Env comes from worker-configuration.d.ts (npx wrangler types):
// secrets OPENROUTER_KEY, APP_TOKEN — .dev.vars locally / wrangler secret in production; VERSION — "vars" in wrangler.jsonc or --var at deploy

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] };

// Request body from the app. Two shapes:
//  1) full:  { messages: [...] } — OpenAI-style, images as data: URLs inside content parts
//  2) short: { text: "...", image?: "data:image/jpeg;base64,..." } — handy for curl and demos
type AppRequest = { messages?: ChatMessage[]; text?: string; image?: string };

type FeatureConfig = {
	models: string[]; // first is primary, the rest are fallbacks (tried on 402/403/404/429/5xx, empty answer, or truncation)
	system: string;
	maxTokens: number;
};

// One place to edit for all features: adding a feature = adding an entry.
// Models are OpenRouter free tier. dots-3 accepts images; nemotron is text-only and is skipped when the request has an image.
// (inkling-small:free is listed by the API but gated to "agentic harnesses" — returns 403 — so it is not used.)
const FEATURES: Record<string, FeatureConfig> = {
	dexa: {
		models: ['dots-studio/dots-3-note-preview:free', 'nvidia/nemotron-3.5-lightning:free'],
		system:
			'You help a person understand a DEXA (bone density) scan report. ' +
			'Explain T-score and Z-score values in plain language, say which range they fall into (normal, osteopenia, osteoporosis) ' +
			'according to standard WHO thresholds, and list sensible questions to ask their doctor. ' +
			'Do not diagnose or recommend medication. Be concise and calm. Start with the substance: never open with "Of course", "Sure", "Certainly" or a restatement of the request.',
		maxTokens: 1500,
	},
	food: {
		models: ['dots-studio/dots-3-note-preview:free', 'nvidia/nemotron-3.5-lightning:free'],
		system:
			'You estimate the nutritional content of a meal from a photo or a description. ' +
			'List the likely items with approximate portions, then give rough calories, protein, carbs, fat and calcium, ' +
			'and state clearly that these are estimates. Keep it short and structured. Start with the substance: never open with "Of course", "Sure", "Certainly" or a restatement of the request.',
		maxTokens: 1500,
	},
};

const TEXT_ONLY = new Set(['nvidia/nemotron-3.5-lightning:free']);
const MAX_BODY_BYTES = 6 * 1024 * 1024; // enough for a phone photo as base64; refuse anything larger up front
const UPSTREAM_TIMEOUT_MS = 25_000;
const RETRY_STATUSES = new Set([402, 403, 404, 429]);

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
	new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
	});

function toMessages(body: AppRequest): ChatMessage[] | null {
	if (Array.isArray(body.messages) && body.messages.length > 0) {
		// the system prompt is owned by the Worker; a client must not be able to replace it
		return body.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
	}
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	const image = typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : null;
	if (!text && !image) return null;
	const parts: ContentPart[] = [{ type: 'text', text: text || 'Describe what you see and answer accordingly.' }];
	if (image) parts.push({ type: 'image_url', image_url: { url: image } });
	return [{ role: 'user', content: parts }];
}

// Free-tier models keep opening with "Of course. Here is ..." however the system prompt is worded,
// so the acknowledgement is stripped here. Only a leading filler sentence goes; the answer itself is untouched.
const PREAMBLE = /^(of course|sure|certainly|absolutely|no problem|got it)\b[!.,]*\s*(here(?:'s| is| are)[^\n.!?]*[.!:]?\s*)?/i;

export function stripPreamble(text: string): string {
	const stripped = text.replace(PREAMBLE, '').trimStart();
	return stripped.length > 0 ? stripped : text;
}

function hasImage(messages: ChatMessage[]): boolean {
	return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
}

type UpstreamResponse = {
	choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
	usage?: unknown;
	error?: unknown;
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const version = env.VERSION ?? 'dev';
		const base = { 'x-worker-version': version };

		// route by feature: /dexa, /food — guard against prototype keys ("constructor", "__proto__", ...)
		const feature = url.pathname.replace(/^\/|\/$/g, '');
		const cfg = Object.hasOwn(FEATURES, feature) ? FEATURES[feature] : undefined;

		if (request.method === 'GET') {
			// GET / — self-description, so the link can be opened in a browser
			if (feature === '') {
				return json(
					{
						service: 'openrouter-proxy-worker',
						version,
						routes: Object.keys(FEATURES).map((f) => `POST /${f}`),
						auth: 'header x-app-token',
						body: { text: 'string', image: 'optional data:image/...;base64,...' },
						alt_body: { messages: 'OpenAI-style messages array (user/assistant only)' },
						note: 'Free-tier OpenRouter models; answers are illustrative, the proxy pattern is the point.',
					},
					200,
					base,
				);
			}
			// GET /<feature> — feature description without calling a model
			if (cfg) {
				return json(
					{
						feature,
						version,
						models: { primary: cfg.models[0], fallbacks: cfg.models.slice(1) },
						key: 'OpenRouter key is a Worker secret; the app never sees it',
						privacy: 'provider.data_collection = "deny" is set in the request body on every call',
						auth: 'POST requires header x-app-token',
						try: { method: 'POST', path: `/${feature}`, body: { text: '…', image: 'optional data:image/jpeg;base64,…' } },
					},
					200,
					{ ...base, 'x-feature': feature },
				);
			}
			return json({ error: 'Not found', known: Object.keys(FEATURES) }, 404, base);
		}
		if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, base);

		// app authentication — so the Worker is not an open proxy
		if (request.headers.get('x-app-token') !== env.APP_TOKEN) return json({ error: 'Unauthorized' }, 401, base);

		if (!cfg) return json({ error: `Unknown feature: ${feature}`, known: Object.keys(FEATURES) }, 404, base);

		const declared = Number(request.headers.get('content-length') ?? 0);
		if (declared > MAX_BODY_BYTES) return json({ error: 'Body too large', max_bytes: MAX_BODY_BYTES }, 413, base);

		let body: AppRequest;
		try {
			const raw = await request.text();
			if (raw.length > MAX_BODY_BYTES) return json({ error: 'Body too large', max_bytes: MAX_BODY_BYTES }, 413, base);
			body = JSON.parse(raw) as AppRequest;
		} catch {
			return json({ error: 'Invalid JSON' }, 400, base);
		}
		const userMessages = toMessages(body);
		if (!userMessages) return json({ error: 'Provide { text, image? } or { messages[] }' }, 400, base);

		const messages: ChatMessage[] = [{ role: 'system', content: cfg.system }, ...userMessages];
		const withImage = hasImage(messages);
		const candidates = cfg.models.filter((m) => !(withImage && TEXT_ONLY.has(m)));

		const attempts: Array<{ model: string; status: number; reason: string; ms: number }> = [];
		for (const model of candidates) {
			const started = Date.now();
			let upstream: Response;
			try {
				upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${env.OPENROUTER_KEY}`, // the key lives only here
						'Content-Type': 'application/json',
						'HTTP-Referer': 'https://github.com/ivansaldayev/openrouter-proxy-worker', // shown in OpenRouter's usage stats
						'X-Title': 'openrouter-proxy-worker',
					},
					body: JSON.stringify({
						model,
						messages,
						max_tokens: cfg.maxTokens,
						reasoning: { effort: 'low', exclude: true }, // reasoning models otherwise burn the token budget before answering
						provider: { data_collection: 'deny' }, // zero-data-retention in the request body, not in a dashboard setting
					}),
					signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
				});
			} catch (e) {
				attempts.push({ model, status: 0, reason: e instanceof Error ? e.name : 'fetch failed', ms: Date.now() - started });
				continue;
			}

			// gated/missing model, rate limit, upstream outage — try the next model
			if (RETRY_STATUSES.has(upstream.status) || upstream.status >= 500) {
				attempts.push({ model, status: upstream.status, reason: 'upstream status', ms: Date.now() - started });
				await upstream.body?.cancel();
				continue;
			}

			let data: UpstreamResponse;
			try {
				data = (await upstream.json()) as UpstreamResponse;
			} catch {
				attempts.push({ model, status: upstream.status, reason: 'non-JSON upstream body', ms: Date.now() - started });
				continue;
			}
			if (!upstream.ok || data.error) {
				// do not forward upstream 400/401 as-is: the app would confuse "my token is wrong" with "the Worker's key is wrong"
				console.log(JSON.stringify({ feature, model, upstream_status: upstream.status, error: data.error }));
				return json({ error: 'Upstream error', upstream_status: upstream.status, model, fallbacks_tried: attempts }, 502, {
					...base,
					'x-feature': feature,
					'x-model': model,
				});
			}

			const choice = data.choices?.[0];
			const answer = stripPreamble((choice?.message?.content ?? '').trim());
			if (!answer || choice?.finish_reason === 'length') {
				// an empty or truncated answer is a failure, not a 200
				attempts.push({
					model,
					status: upstream.status,
					reason: answer ? 'truncated (finish_reason=length)' : 'empty answer',
					ms: Date.now() - started,
				});
				continue;
			}

			console.log(JSON.stringify({ feature, model, ms: Date.now() - started, fallbacks: attempts.length }));
			return json({ feature, model, answer, finish_reason: choice?.finish_reason, usage: data.usage, fallbacks_tried: attempts }, 200, {
				...base,
				'x-feature': feature,
				'x-model': model,
			});
		}

		console.log(JSON.stringify({ feature, error: 'all models failed', attempts }));
		return json({ error: 'All models unavailable', fallbacks_tried: attempts }, 502, { ...base, 'x-feature': feature });
	},
} satisfies ExportedHandler<Env>;
