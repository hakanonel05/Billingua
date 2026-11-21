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
  // Paragraphs per request. Services limited by requests per day (Gemini) get large batches;
  // services limited by tokens per minute (Groq: 8,000) get batches that fit the limit.
  batchParagraphs: number;
  // Other models of the same service, tried in order when the chosen one runs out of quota
  // (quotas are counted per model).
  backupModels?: string[];
}

// The first preset is the default: an open model, fast and free (needs a free key).
export const LLM_PRESETS: LlmPreset[] = [
  {
    id: 'groq',
    name: 'Groq — açık modeller, bulutta (önerilen)',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'qwen/qwen3.8-27b',
    needsKey: true,
    hint: 'console.groq.com adresinden ücretsiz bir anahtar alın. Qwen modeli Türkçe edebi çeviride Google\'dan belirgin şekilde iyi sonuç veriyor. Ücretsiz katman: günde yaklaşık 200.000 token (yaklaşık 1.000 paragraf).',
    batchParagraphs: 20,
  },
  {
    id: 'google',
    name: 'Google AI Studio — Gemini (Google API anahtarıyla)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash',
    needsKey: true,
    hint: 'aistudio.google.com/apikey adresinden anahtar alın. Ücretsiz katmanda her Gemini modeli günde ayrı bir istek kotasına sahip; uygulama tek istekte 50 paragraf gönderir ve kota dolunca sırayla 3.7, 3.6, 3.5 Flash modellerine geçer. Gemini açık kaynak değildir; buradaki açık Gemma modelleri ise çok yavaştır. Kalan kotanızı aistudio.google.com/rate-limit sayfasında görebilirsiniz.',
    batchParagraphs: 50,
    backupModels: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'],
  },
  {
    id: 'ollama',
    name: 'Ollama — bilgisayarımda, ücretsiz',
    baseUrl: 'http://localhost:11434/v1',
    model: 'gemma3:4b',
    needsKey: false,
    hint: 'ollama.com adresinden kurun, sonra terminalde: ollama pull gemma3:4b. Daha iyi sonuç için daha büyük bir model (gemma3:12b, qwen2.5:14b) seçin.',
    batchParagraphs: 10,
  },
  {
    id: 'lmstudio',
    name: 'LM Studio — bilgisayarımda, ücretsiz',
    baseUrl: 'http://localhost:1234/v1',
    model: '',
    needsKey: false,
    hint: 'LM Studio\'da bir model indirin, Developer sekmesinden sunucuyu başlatın ve "Enable CORS" seçeneğini açın.',
    batchParagraphs: 10,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter — açık modeller, bulutta',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    needsKey: true,
    hint: 'openrouter.ai adresinden anahtar alın, sonra "Modelleri getir" ile bir açık model (Llama, Qwen, Gemma, Mistral) seçin. Ücretsiz modellerde günde 50 istek sınırı vardır.',
    batchParagraphs: 30,
  },
  {
    id: 'custom',
    name: 'Diğer — OpenAI uyumlu sunucu',
    baseUrl: '',
    model: '',
    needsKey: false,
    hint: 'llama.cpp, vLLM gibi OpenAI uyumlu (/v1/chat/completions) her sunucu çalışır.',
    batchParagraphs: 10,
  },
];

// Paragraphs per request for a service; unknown servers get a safe default.
export const batchSizeOf = (s: LlmSettings) => presetOf(s)?.batchParagraphs ?? 10;

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
// A request that hasn't answered after this long is given up on, so a stalled connection can't
// freeze a book (local models on a slow computer may need minutes for a batch).
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// What the AI client is doing right now, for the progress screen: waiting for an answer, or
// waiting out a per-minute rate limit before asking again. Without it a long wait looks like a hang.
export type LlmActivity =
  | { kind: 'request'; model: string; since: number }
  | { kind: 'rate-limit'; model: string; until: number }
  | { kind: 'idle' };
let activityListener: ((a: LlmActivity) => void) | null = null;
export const onLlmActivity = (fn: ((a: LlmActivity) => void) | null) => { activityListener = fn; };
const report = (a: LlmActivity) => activityListener?.(a);

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
  const model = s.llmModel.trim();
  let res: Response;
  try {
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      try {
        report({ kind: 'request', model, since: Date.now() });
        res = await fetch(endpoint(s, '/chat/completions'), {
          method: 'POST', headers: headers(s), body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        if (timeout.aborted) {
          // Not fatal: the batch keeps its Google draft and the book goes on.
          throw new LlmError(`${model} ${Math.round(REQUEST_TIMEOUT_MS / 60_000)} dakika içinde yanıt vermedi.`, 408);
        }
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
        const wait = Math.min((limit.retryMs ?? 2000 * 2 ** attempt) + 250, MAX_RETRY_WAIT_MS);
        report({ kind: 'rate-limit', model, until: Date.now() + wait });
        await sleep(wait);
        continue;
      }
      // Transient server errors (Google's endpoint returns occasional 500s).
      if (res.status >= 500 && attempt < MAX_BUSY_RETRIES) {
        await sleep(retryDelayMs(res, attempt));
        continue;
      }
      break;
    }
  } finally {
    report({ kind: 'idle' });
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

// The items of a batch reply, even a broken one: when the reply as a whole doesn't parse (a model
// left a quote unescaped inside one translation), every item that is still well-formed is kept.
export function parseItemsReply(reply: string): { id: number; text: string }[] {
  try {
    const parsed = parseJsonReply(reply);
    const list = Array.isArray(parsed) ? parsed : parsed?.items;
    if (Array.isArray(list)) {
      return list
        .map((r: any) => ({ id: Number(r?.id), text: r?.text ?? r?.translation }))
        .filter(r => Number.isInteger(r.id) && typeof r.text === 'string');
    }
  } catch {
    // fall through to item-by-item salvage
  }
  const salvaged: { id: number; text: string }[] = [];
  const item = /\{\s*"id"\s*:\s*"?(\d+)"?\s*,\s*"(?:text|translation)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  for (const m of reply.matchAll(item)) {
    try {
      salvaged.push({ id: Number(m[1]), text: JSON.parse(`"${m[2]}"`) });
    } catch {
      // this one is broken too
    }
  }
  return salvaged;
}

export interface IdText {
  id: number;
  text: string;
  // Optional machine-translation draft the model may refine.
  draft?: string;
}

// Runs one instruction over a batch of paragraphs. The batch goes out as one JSON request; items
// missing from the reply (broken JSON, skipped items) are asked for again together, once, and only
// what is still missing after that goes out one by one as plain text, which even weak models handle.
// Quota-limited services thus pay one or two requests per batch, not one per paragraph.
// Returns whatever came back; failures are omitted.
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

  const wanted = new Set(items.map(i => i.id));
  // False when the request itself failed (timeout, server error) rather than the reply being
  // incomplete: then asking paragraph by paragraph would only multiply failing requests.
  const askBatch = async (batch: IdText[]): Promise<boolean> => {
    try {
      const reply = await chat(s, [
        { role: 'system', content: `${instruction}\nAnswer only with JSON of the form {"items":[{"id":<number>,"text":"<result>"}]}, one item per input, same ids, nothing else. Escape double quotes inside the text as \\".` },
        { role: 'user', content: `${contextBlock}${JSON.stringify({ items: batch })}` },
      ], { json: true });
      for (const r of parseItemsReply(reply)) {
        if (wanted.has(r.id) && r.text.trim()) results.set(r.id, r.text.trim());
      }
      return true;
    } catch (err) {
      if (isFatal(err)) throw err;
      console.warn('Batch request failed', err);
      return false;
    }
  };

  if (items.length > 1) {
    let answered = await askBatch(items);
    const missing = items.filter(i => !results.has(i.id));
    if (missing.length > 1) answered = await askBatch(missing);
    if (!answered) return results;
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
