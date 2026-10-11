// Client for any OpenAI-compatible chat server: local open-source runtimes (Ollama, LM Studio,
// llama.cpp, vLLM) or hosted open models (Groq, OpenRouter). Calls go straight from the browser.

export interface LlmSettings {
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

export const LLM_PRESETS: LlmPreset[] = [
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
    id: 'groq',
    name: 'Groq — açık modeller, bulutta',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    needsKey: true,
    hint: 'console.groq.com adresinden ücretsiz bir anahtar alın.',
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

export const isLlmConfigured = (s: LlmSettings) => !!s.llmBaseUrl.trim() && !!s.llmModel.trim();

const endpoint = (s: LlmSettings, path: string) => `${s.llmBaseUrl.trim().replace(/\/+$/, '')}${path}`;

const headers = (s: LlmSettings): Record<string, string> => {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (s.llmApiKey.trim()) h.Authorization = `Bearer ${s.llmApiKey.trim()}`;
  return h;
};

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
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

export async function chat(
  s: LlmSettings,
  messages: { role: 'system' | 'user'; content: string }[],
  { json = false, signal }: { json?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const body: Record<string, unknown> = { model: s.llmModel.trim(), messages, temperature: 0.2, stream: false };
  if (json) body.response_format = { type: 'json_object' };

  let res: Response;
  try {
    res = await fetch(endpoint(s, '/chat/completions'), { method: 'POST', headers: headers(s), body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new LlmError(describeNetworkError(s), 0);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new LlmError(`Yapay zeka sunucusu HTTP ${res.status} döndürdü ${detail.slice(0, 200)}`, res.status);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new LlmError('Yapay zeka boş yanıt döndürdü');
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
}

// Runs one instruction over a batch of paragraphs. The batch goes out as one JSON request; when a
// (small, local) model returns broken JSON or skips items, the missing ones are retried one by one
// as plain text, which even weak models handle. Returns whatever came back; failures are omitted.
export async function mapParagraphs(
  s: LlmSettings,
  instruction: string,
  items: IdText[],
  context: string[] = [],
): Promise<Map<number, string>> {
  const results = new Map<number, string>();
  const contextBlock = context.length
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
        { role: 'user', content: `${contextBlock}${item.text}` },
      ]);
      results.set(item.id, reply.trim());
    } catch (err) {
      if (isFatal(err)) throw err;
      console.warn(`Paragraph ${item.id} failed`, err);
    }
  }
  return results;
}
