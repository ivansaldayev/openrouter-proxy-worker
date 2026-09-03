// Env берётся из worker-configuration.d.ts (npx wrangler types):
// секреты OPENROUTER_KEY, APP_TOKEN — из .dev.vars / wrangler secret; VERSION — из "vars" в wrangler.jsonc

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

// Тело запроса от приложения. Два варианта:
//  1) полный: { messages: [...] } — как в OpenAI-совместимом API, картинки как data:-URL внутри content
//  2) короткий: { text: "...", image?: "data:image/jpeg;base64,..." } — удобно для curl и демо
type AppRequest = { messages?: ChatMessage[]; text?: string; image?: string; stream?: boolean };

type FeatureConfig = {
  models: string[]; // первый — основной, дальше — фолбэки при 404/429/5xx
  system: string;
  maxTokens: number;
};

// Одна точка правки на все фичи: добавить фичу = добавить запись.
// Модели — бесплатные на OpenRouter (проверено 3 сен 2026): inkling-small и dots-3 принимают изображения,
// nemotron — только текст, поэтому он фолбэк лишь для текстовых запросов.
const FEATURES: Record<string, FeatureConfig> = {
  dexa: {
    models: ["thinkingmachines/inkling-small:free", "dots-studio/dots-3-note-preview:free", "nvidia/nemotron-3.5-lightning:free"],
    system:
      "You help a person understand a DEXA (bone density) scan report. " +
      "Explain T-score and Z-score values in plain language, say which range they fall into (normal, osteopenia, osteoporosis) " +
      "according to standard WHO thresholds, and list sensible questions to ask their doctor. " +
      "Do not diagnose or recommend medication. Be concise and calm.",
    maxTokens: 700,
  },
  food: {
    models: ["dots-studio/dots-3-note-preview:free", "thinkingmachines/inkling-small:free", "nvidia/nemotron-3.5-lightning:free"],
    system:
      "You estimate the nutritional content of a meal from a photo or a description. " +
      "List the likely items with approximate portions, then give rough calories, protein, carbs, fat and calcium, " +
      "and state clearly that these are estimates. Keep it short and structured.",
    maxTokens: 600,
  },
};

const TEXT_ONLY = new Set(["nvidia/nemotron-3.5-lightning:free"]);

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });

function toMessages(body: AppRequest): ChatMessage[] | null {
  if (Array.isArray(body.messages) && body.messages.length > 0) return body.messages;
  if (typeof body.text === "string" && body.text.trim()) {
    const parts: ContentPart[] = [{ type: "text", text: body.text.trim() }];
    if (typeof body.image === "string" && body.image.startsWith("data:image/")) {
      parts.push({ type: "image_url", image_url: { url: body.image } });
    }
    return [{ role: "user", content: parts }];
  }
  return null;
}

function hasImage(messages: ChatMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const version = env.VERSION ?? "dev";
    const base = { "x-worker-version": version };

    // GET / — самоописание, чтобы ссылку можно было открыть в браузере
    if (request.method === "GET" && url.pathname === "/") {
      return json(
        {
          service: "openrouter-proxy-worker",
          version,
          routes: Object.keys(FEATURES).map((f) => `POST /${f}`),
          auth: "header x-app-token",
          body: { text: "string", image: "optional data:image/...;base64,..." },
          alt_body: { messages: "OpenAI-style messages array" },
          note: "Free-tier OpenRouter models; answers are illustrative, the proxy pattern is the point.",
        },
        200,
        base,
      );
    }
    // маршрутизация по фичам: /dexa, /food
    const feature = url.pathname.slice(1);
    const cfg = FEATURES[feature];

    // GET /<feature> — описание фичи без вызова модели, читается в браузере
    if (request.method === "GET" && cfg) {
      return json(
        {
          feature,
          version,
          models: { primary: cfg.models[0], fallbacks: cfg.models.slice(1) },
          key: "OpenRouter key is a Worker secret; the app never sees it",
          privacy: 'provider.data_collection = "deny" is set in the request body on every call',
          auth: "POST requires header x-app-token",
          try: { method: "POST", path: `/${feature}`, body: { text: "…", image: "optional data:image/jpeg;base64,…" } },
        },
        200,
        { ...base, "x-feature": feature },
      );
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, base);

    // авторизация приложения — чтобы Worker не был открытым прокси
    if (request.headers.get("x-app-token") !== env.APP_TOKEN) return json({ error: "Unauthorized" }, 401, base);

    if (!cfg) return json({ error: `Unknown feature: ${feature}`, known: Object.keys(FEATURES) }, 404, base);

    let body: AppRequest;
    try {
      body = (await request.json()) as AppRequest;
    } catch {
      return json({ error: "Invalid JSON" }, 400, base);
    }
    const userMessages = toMessages(body);
    if (!userMessages) return json({ error: "Provide { text, image? } or { messages[] }" }, 400, base);

    const messages: ChatMessage[] = [{ role: "system", content: cfg.system }, ...userMessages];
    const withImage = hasImage(messages);
    const candidates = cfg.models.filter((m) => !(withImage && TEXT_ONLY.has(m)));

    const attempts: Array<{ model: string; status: number }> = [];
    for (const model of candidates) {
      const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_KEY}`, // ключ живёт только здесь
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/ivansaldayev", // OpenRouter показывает источник трафика в своей статистике
          "X-Title": "openrouter-proxy-worker",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: cfg.maxTokens,
          provider: { data_collection: "deny" }, // zero-data-retention в теле запроса, не в дашборде
        }),
      });

      // 404 (модели нет), 429 (лимит бесплатной модели), 5xx — пробуем следующую
      if (upstream.status === 404 || upstream.status === 429 || upstream.status >= 500) {
        attempts.push({ model, status: upstream.status });
        continue;
      }

      const data = (await upstream.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: unknown;
        error?: unknown;
      };
      if (!upstream.ok) return json({ error: data.error ?? "Upstream error", model }, upstream.status, { ...base, "x-feature": feature, "x-model": model });

      return json(
        {
          feature,
          model,
          answer: data.choices?.[0]?.message?.content ?? "",
          usage: data.usage,
          fallbacks_tried: attempts,
        },
        200,
        { ...base, "x-feature": feature, "x-model": model },
      );
    }

    return json({ error: "All models unavailable", attempts }, 502, { ...base, "x-feature": feature });
  },
} satisfies ExportedHandler<Env>;
