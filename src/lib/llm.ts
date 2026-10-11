// Client for any OpenAI-compatible chat server: local open-source runtimes (Ollama, LM Studio,
// llama.cpp, vLLM), hosted open models (Groq, OpenRouter) or Google's Gemini API.
// Calls go straight from the browser.

export interface LlmSettings {
  llmProvider?: string;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
}

export interface LlmPreset {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  hint: string;
}

// The first preset is the default: an open model, fast and free (needs a free key).
export const LLM_PRESETS: LlmPreset[] = [
  {
    id: 'groq',
    name: 'Groq — açık modeller, bulutta (önerilen)',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'qwen/qwen3.8-27b',
    needsKey: true,
    hint: 'console.groq.com adresinden ücretsiz bir anahtar alın. Qwen modeli Türkçe edebi çeviride Google\'dan belirgin şekilde iyi sonuç veriyor.',
  },
  {
    id: 'google',
    name: 'Google AI Studio — Gemini (Google API anahtarıyla)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.5-flash-lite',
    needsKey: true,
    hint: 'aistudio.google.com/apikey adresinden anahtar alın. Ücretsiz katmanda gemini-3.8-flash günde yalnızca 20 istek verir (bir kitap için yetmez); varsayılan gemini-3.5-flash-lite daha bol kotalıdır. Gemini açık kaynak değildir; buradaki açık Gemma modelleri ise çok yavaştır. Kalan kotanızı aistudio.google.com/rate-limit sayfasında görebilirsiniz.',
  },
  {
    id: 'ollama',
    name: 'Ollama — bilgisayarımda, ücretsiz',
    baseUrl: 'http://localhost:11434/v1',
    model: 'gemma3:4b',
    needsKey: false,
    hint: 'ollama.com adresinden kurun, sonra terminalde: ollama pull gemma3:4b. Daha iyi sonuç için daha büyük bir model (gemma3:12b, qwen2.5:14b) seçin.',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio — bilgisayarımda, ücretsiz',
    baseUrl: 'http://localhost:1234/v1',
    model: '',
    needsKey: false,
    hint: 'LM Studio\'da bir model indirin, Developer sekmesinden sunucuyu başlatın ve "Enable CORS" seçeneğini açın.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter — açık modeller, bulutta',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    needsKey: true,
    hint: 'openrouter.ai adresinden anahtar alın, sonra "Modelleri getir" ile bir açık model (Llama, Qwen, Gemma, Mistral) seçin.',
  },
  {
    id: 'custom',
    name: 'Diğer — OpenAI uyumlu sunucu',
    baseUrl: '',
    model: '',
    needsKey: false,
    hint: 'llama.cpp, vLLM gibi OpenAI uyumlu (/v1/chat/completions) her sunucu çalışır.',
  },
];

export const presetOf = (s: LlmSettings) => LLM_PRESETS.find(p => p.id === s.llmProvider);

// Ready to use: a server, a model, and a key when the service needs one.
export const isLlmConfigured = (s: LlmSettings) =>
  !!s.llmBaseUrl.trim() && !!s.llmModel.trim() && !(presetOf(s)?.needsKey && !s.llmApiKey.trim());

const endpoint = (s: LlmSettings, path: string) => `${s.llmBaseUrl.trim().replace(/\/+$/, '')}${path}`;

const headers = (s: LlmSettings): Record<string, string> => {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (s.llmApiKey.trim()) h.Authorization = `Bearer ${s.llmApiKey.trim()}`;
  return h;
};

export class LlmError extends Error {
  // retryAfterMs: how long the service said to wait (rate limits), when it said so.
  constructor(message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

// Errors that won't go away by retrying the next paragraph: server down, bad key, unknown model, quota.
export const isFatal = (err: unknown) =>
  err instanceof LlmError && [0, 401, 402, 403, 404, 429].includes(err.status ?? -1);

const describeNetworkError = (s: LlmSettings) => {
  const local = /localhost|127\.0\.0\.1/.test(s.llmBaseUrl);
  return local
    ? `Yapay zeka sunucusuna ulaşılamadı (${s.llmBaseUrl}). Ollama / LM Studio çalışıyor mu? LM Studio'da CORS açık mı?`
    : `Yapay zeka sunucusuna ulaşılamadı (${s.llmBaseUrl}).`;
};

export async function listModels(s: LlmSettings): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(endpoint(s, '/models'), { headers: headers(s) });
  } catch {
    throw new LlmError(describeNetworkError(s), 0);
  }
  if (!res.ok) throw new LlmError(`Model listesi alınamadı (HTTP ${res.status})`, res.status);
  const data = await res.json();
  const ids: string[] = (data?.data || data?.models || []).map((m: any) => m.id || m.name).filter(Boolean);
  return ids.sort((a, b) => a.localeCompare(b));
}

export const stripThinking = (reply: string) =>
  reply.replace(/<think>[\s\S]*?<\/think>|<thought>[\s\S]*?<\/thought>/g, '').trim();

// Gemini models think before answering unless told not to, which makes a translation several
// times slower without making it better. Some (Flash-Lite, Gemma) reject the switch; those are
// remembered and asked again without it.
const rejectsNoReasoning = new Set<string>();
const wantsNoReasoning = (s: LlmSettings) =>
  /generativelanguage\.googleapis\.com/.test(s.llmBaseUrl) && /^gemini-/.test(s.llmModel.trim())
  && !rejectsNoReasoning.has(s.llmModel.trim());

const MAX_BUSY_RETRIES = 4;
const MAX_RETRY_WAIT_MS = 65_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Retry-After in milliseconds (seconds or HTTP date), or null when absent.
const headerRetryMs = (res: Response): number | null => {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const ms = /^\d+(\.\d+)?$/.test(header.trim()) ? parseFloat(header) * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

// Honors Retry-After when the server sends it, else backs off 2s, 4s, 8s...
export const retryDelayMs = (res: Response, attempt: number): number =>
  Math.min((headerRetryMs(res) ?? 2000 * 2 ** attempt) + 250, MAX_RETRY_WAIT_MS);

const formatDuration = (ms: number) => {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 1) return `${Math.ceil(ms / 1000)} saniye`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} saat${m ? ` ${m} dakika` : ''}` : `${m} dakika`;
};

export interface RateLimit {
  retryMs: number | null;
  daily: boolean;
  message: string;
}

// Reads what a 429 says: how long to wait and whether a daily quota ran out, as a message a reader
// understands. Gemini puts it in error.details (quotaId "...PerDay...", quotaValue, retryDelay "19222s");
// Groq in error.message ("... tokens per day (TPD): Limit 100000 ... Please try again in 7m12.5s").
export const parseRateLimit = (bodyText: string, headerMs: number | null, model: string): RateLimit => {
  let json: any;
  try { json = JSON.parse(bodyText); } catch { /* not JSON */ }
  const error = (Array.isArray(json) ? json[0] : json)?.error ?? {};
  const text = typeof error.message === 'string' ? error.message : bodyText;

  let retryMs = headerMs;
  let daily = /per ?day|\(TPD\)|\(RPD\)/i.test(text);
  let limit: string | undefined;
  for (const detail of Array.isArray(error.details) ? error.details : []) {
    const seconds = parseFloat(detail?.retryDelay);
    if (Number.isFinite(seconds)) retryMs = seconds * 1000;
    for (const v of detail?.violations || []) {
      if (/PerDay/i.test(v?.quotaId || '')) daily = true;
      if (v?.quotaValue) limit = String(v.quotaValue);
    }
  }
  const wait = text.match(/try again in ((?:\d+h)?(?:\d+m)?(?:[\d.]+s)?)/i);
  if (retryMs == null && wait?.[1]) {
    const part = (unit: string) => parseFloat(wait[1].match(new RegExp(`([\\d.]+)${unit}`))?.[1] || '0');
    retryMs = (part('h') * 3600 + part('m') * 60 + part('s')) * 1000;
  }

  const when = retryMs ? formatDuration(retryMs) : null;
  const message = daily
    ? `${model} modelinin günlük ücretsiz kotası doldu${limit ? ` (günde ${limit} istek)` : ''}.${when ? ` Yaklaşık ${when} sonra yenilenir.` : ''}`
    : `${model} modelinin istek sınırı aşıldı.${when ? ` ${when} sonra yeniden denenebilir.` : ''}`;
  return { retryMs, daily, message };
};

export async function chat(
  s: LlmSettings,
  messages: { role: 'system' | 'user'; content: string }[],
  { json = false, signal }: { json?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const body: Record<string, unknown> = { model: s.llmModel.trim(), messages, temperature: 0.2, stream: false };
  if (json) body.response_format = { type: 'json_object' };
  if (wantsNoReasoning(s)) body.reasoning_effort = 'none';

  // Free tiers (Groq, OpenRouter) limit requests and tokens per minute: wait as told and retry
  // instead of giving up on the model. Only a limit that outlasts the retries is reported.
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(endpoint(s, '/chat/completions'), { method: 'POST', headers: headers(s), body: JSON.stringify(body), signal });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      throw new LlmError(describeNetworkError(s), 0);
    }
    if (res.status === 400 && 'reasoning_effort' in body) {
      rejectsNoReasoning.add(s.llmModel.trim());
      delete body.reasoning_effort;
      continue;
    }
    if (res.status === 429) {
      const limit = parseRateLimit(await res.clone().text().catch(() => ''), headerRetryMs(res), s.llmModel.trim());
      // A daily quota, or a wait longer than a minute, won't clear by retrying now.
      if (limit.daily || (limit.retryMs ?? 0) > MAX_RETRY_WAIT_MS || attempt >= MAX_BUSY_RETRIES) {
        throw new LlmError(limit.message, 429, limit.retryMs ?? undefined);
      }
      await sleep(Math.min((limit.retryMs ?? 2000 * 2 ** attempt) + 250, MAX_RETRY_WAIT_MS));
      continue;
    }
    // Transient server errors (Google's endpoint returns occasional 500s).
    if (res.status >= 500 && attempt < MAX_BUSY_RETRIES) {
      await sleep(retryDelayMs(res, attempt));
      continue;
    }
    break;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new LlmError(`Yapay zeka sunucusu HTTP ${res.status} döndürdü ${detail.slice(0, 200)}`, res.status);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content;
  // Reasoning models put their thinking in the reply: <think> (Qwen 3, DeepSeek R1), <thought> (Gemma 4).
  const content = typeof raw === 'string' ? stripThinking(raw) : '';
  if (!content) throw new LlmError('Yapay zeka boş yanıt döndürdü');
  return content;
}

// Pulls a JSON value out of a model reply that may be wrapped in prose or code fences.
export function parseJsonReply(reply: string): any {
  const text = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new LlmError('Yapay zeka yanıtı JSON değil');
  }
}

export interface IdText {
  id: number;
  text: string;
  // Optional machine-translation draft the model may refine.
  draft?: string;
}

// Runs one instruction over a batch of paragraphs. The batch goes out as one JSON request; when a
// (small, local) model returns broken JSON or skips items, the missing ones are retried one by one
// as plain text, which even weak models handle. Returns whatever came back; failures are omitted.
// `context` is either the preceding source paragraphs or a ready-made context block.
export async function mapParagraphs(
  s: LlmSettings,
  instruction: string,
  items: IdText[],
  context: string[] | string = [],
): Promise<Map<number, string>> {
  const results = new Map<number, string>();
  const contextBlock = typeof context === 'string'
    ? (context ? `${context}\n\n` : '')
    : context.length
      ? `The passage just before these texts, for context only (do not include it in the output):\n"""\n${context.join('\n\n')}\n"""\n\n`
      : '';

  if (items.length > 1) {
    try {
      const reply = await chat(s, [
        { role: 'system', content: `${instruction}\nAnswer only with JSON of the form {"items":[{"id":<number>,"text":"<result>"}]}, one item per input, same ids, nothing else.` },
        { role: 'user', content: `${contextBlock}${JSON.stringify({ items })}` },
      ], { json: true });
      const parsed = parseJsonReply(reply);
      const list = Array.isArray(parsed) ? parsed : parsed?.items;
      const wanted = new Set(items.map(i => i.id));
      if (Array.isArray(list)) {
        for (const r of list) {
          const text = r?.text ?? r?.translation;
          if (wanted.has(r?.id) && typeof text === 'string' && text.trim()) results.set(r.id, text.trim());
        }
      }
    } catch (err) {
      if (isFatal(err)) throw err;
      console.warn('Batch request failed; retrying paragraphs one by one', err);
    }
  }

  for (const item of items) {
    if (results.has(item.id)) continue;
    try {
      const reply = await chat(s, [
        { role: 'system', content: `${instruction}\nAnswer with the resulting text only: no quotes around it, no explanations, no notes.` },
        { role: 'user', content: item.draft
          ? `${contextBlock}Text:\n${item.text}\n\nDraft translation (may be wrong):\n${item.draft}`
          : `${contextBlock}${item.text}` },
      ]);
      results.set(item.id, reply.trim());
    } catch (err) {
      if (isFatal(err)) throw err;
      console.warn(`Paragraph ${item.id} failed`, err);
    }
  }
  return results;
}
