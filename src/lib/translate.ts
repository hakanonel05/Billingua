import type { MutableRefObject } from 'react';
import type { AppConfig, SimplifyLevel, TranslationPayload, TranslationResult } from '../types';
import { getCachedTranslations, setCachedTranslations } from './db';
import { isFatal, isLlmConfigured, mapParagraphs } from './llm';

export interface TranslateContext {
  // Source paragraphs right before this batch, so the model knows who "he" is (AI engine only).
  precedingText?: string[];
  // Recurring character/place names that must stay unchanged (AI engine only).
  names?: string[];
  // The paragraphs right before this batch together with their translations, so names, terms,
  // forms of address and voice stay consistent across the book (AI engine only).
  previousPairs?: { source: string; translation: string }[];
  // Title and author, so the model knows what kind of book it is translating (AI engine only).
  book?: { title?: string; author?: string };
  // Told when the AI engine fails for good (server down, bad key, quota), so the UI can say so.
  onLlmError?: (err: Error) => void;
}

const MAX_CHARS = 2000;
const DELIMITER = '\n\n|||\n\n';
const DELIMITER_RE = /(?:\s*\|\|\|\s*)+/;
const LLM_PAUSE_MS = 60_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// After a fatal error (server down, quota) the model is skipped for a while instead of failing once per batch.
let llmBlockedUntil = 0;
const llmAvailable = (config: AppConfig) => isLlmConfigured(config) && Date.now() >= llmBlockedUntil;

// Set once the /api proxy answers 404 (static hosting), so later requests go straight to Google.
let proxyMissing = false;

const languageName = (code: string) => {
  if (code === 'auto') return 'the detected language';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
};

// --- Cache keys ---
// Each engine writes under its own namespace, so a Google fallback result never masquerades as an
// AI translation on the next run, and AI results depend on the settings that shape them.

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

const GTX_NS = 'gtx';
const llmNamespace = (config: AppConfig) =>
  `llm:${hash(config.llmBaseUrl.trim())}:${config.llmModel.trim()}:${config.tone}:${hash(config.customGlossary || '')}`;
const cacheKey = (ns: string, config: AppConfig, text: string) =>
  `${ns}|${config.sourceLang}>${config.targetLang}|${text}`;

export const chunkByChars = (items: TranslationPayload[], maxChars = MAX_CHARS): TranslationPayload[][] => {
  const chunks: TranslationPayload[][] = [];
  let current: TranslationPayload[] = [];
  let size = 0;
  for (const item of items) {
    const len = item.text.length + DELIMITER.length;
    if (size + len > maxChars && current.length > 0) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

// --- Open-source model (OpenAI-compatible server) ---

export async function translateWithLlm(
  texts: TranslationPayload[],
  config: AppConfig,
  context: TranslateContext = {},
): Promise<TranslationResult[]> {
  const target = languageName(config.targetLang);
  const lines = [`You are an experienced literary translator from ${languageName(config.sourceLang)} into ${target}.`];
  if (context.book?.title) {
    lines.push(`You are translating the book "${context.book.title}"${context.book.author ? ` by ${context.book.author}` : ''}.`);
  }
  lines.push(
    `Write the way a skilled ${target} translator would publish it:`,
    `- Translate the meaning, not word for word. Render idioms, phrasal verbs and figurative verbs (someone who "barked" or "snapped" a reply, "shook" with fear) with the natural ${target} expression for what is meant.`,
    `- Use natural ${target} word order, rhythm and punctuation. Keep the dialogue quotation marks of the original.`,
    `- Keep each character's voice, and keep names, recurring terms and forms of address consistent with the previous passage.`,
    `- Translate every sentence completely: never summarize, merge or split paragraphs, and never add notes or explanations.`,
    `- Maintain a literary tone for fiction and a clear tone for non-fiction.`,
  );
  if (config.targetLang.startsWith('tr')) {
    lines.push('- Choose "sen" or "siz" from the relationship between the speakers and keep that choice for the same pair of characters.');
  }
  if (config.tone !== 'default') lines.push(`- Use a ${config.tone} tone.`);
  if (context.names?.length) lines.push(`- Keep these names exactly as written: ${context.names.join(', ')}.`);
  if (config.customGlossary) lines.push(`Follow these glossary rules:\n${config.customGlossary}`);

  // Earlier source paragraphs with the translations already chosen for them; the source alone
  // when nothing has been translated yet.
  let contextBlock: string | string[] = context.precedingText || [];
  if (context.previousPairs?.length) {
    contextBlock = 'The previous passage and how it was translated, for consistency only (do not include it in the output):\n"""\n'
      + context.previousPairs.map(p => `${p.source}\n=> ${p.translation}`).join('\n\n')
      + '\n"""';
  }

  const translated = await mapParagraphs(config, lines.join('\n'), texts, contextBlock);
  return Array.from(translated, ([id, translation]) => ({ id, translation }));
}

// --- Simplification (graded-reader rewrite) ---

const SIMPLIFY_GUIDE: Record<Exclude<SimplifyLevel, 'off'>, string> = {
  A2: 'Use only very common everyday words and short simple sentences (present and past simple, "and", "but", "because").',
  B1: 'Use common vocabulary and mostly simple or compound sentences; replace rare and literary words with everyday ones.',
  B2: 'Keep a natural style but replace rare, archaic or literary words and untangle very long sentences.',
};

const simplifyNamespace = (config: AppConfig, level: SimplifyLevel) =>
  `simplify:${level}:${hash(config.llmBaseUrl.trim())}:${config.llmModel.trim()}`;

// Rewrites English paragraphs at a lower CEFR level with the AI engine. Returns rewrites only for
// paragraphs that were rewritten; the rest stay as they are. Fatal model errors are thrown.
export async function simplifyBatch(
  texts: TranslationPayload[],
  config: AppConfig,
  level: SimplifyLevel,
  context: TranslateContext = {},
): Promise<Map<number, string>> {
  const results = new Map<number, string>();
  if (level === 'off' || texts.length === 0) return results;
  if (!isLlmConfigured(config)) throw new Error('Metni sadeleştirmek için bir yapay zeka sunucusu ve model seçin.');

  const ns = simplifyNamespace(config, level);
  const key = (text: string) => `${ns}|${text}`;
  const hits = await getCachedTranslations(texts.map(t => key(t.text)));
  const pending = texts.filter((t, i) => {
    if (hits[i]) results.set(t.id, hits[i]!);
    return !hits[i];
  });
  if (pending.length === 0) return results;

  let instruction = `You rewrite fiction and non-fiction for English learners at CEFR level ${level}. Rewrite the text in simpler English. ${SIMPLIFY_GUIDE[level]} Keep every event, fact, line of dialogue and name, in the same order; do not summarize, shorten the story or add anything. Keep quotation marks around dialogue.`;
  if (context.names?.length) instruction += ` Keep these names exactly as written: ${context.names.join(', ')}.`;

  const rewritten = await mapParagraphs(config, instruction, pending, context.precedingText);
  const fresh: [string, string][] = [];
  rewritten.forEach((text, id) => {
    const source = pending.find(t => t.id === id)!.text;
    results.set(id, text);
    fresh.push([key(source), text]);
  });
  await setCachedTranslations(fresh);
  return results;
}

// --- Google Translate ---

const parseGtxResponse = (data: any): string => {
  let out = '';
  if (data && Array.isArray(data[0])) {
    data[0].forEach((s: any) => { if (s && s[0]) out += s[0]; });
  }
  return out;
};

// One translation request with retries: the local proxy first, Google directly when there is no proxy.
async function requestGtx(text: string, config: AppConfig): Promise<string | null> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      let direct = proxyMissing;
      if (!proxyMissing) {
        let response: Response | undefined;
        try {
          response = await fetch('/api/process-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, targetLang: config.targetLang, sourceLang: config.sourceLang })
          });
        } catch (e) {
          console.error("Proxy fetch failed", e);
        }
        if (!response) {
          direct = true; // proxy unreachable this time; try Google directly
        } else if (response.ok) {
          const data = await response.json();
          if (data.translation) return data.translation;
        } else if (response.status === 404 || response.status === 405 || response.status === 502) {
          console.warn("Translation proxy not found; calling Google Translate directly from now on.");
          proxyMissing = direct = true;
        } else if (response?.status === 429) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
      }
      if (direct) {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${config.sourceLang}&tl=${config.targetLang}&dt=t&q=${encodeURIComponent(text)}`;
        const directRes = await fetch(url);
        if (directRes.ok) {
          const out = parseGtxResponse(await directRes.json());
          if (out) return out;
        } else if (directRes.status === 429) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
      }
    } catch (err) {
      console.error(`Translation request failed (attempt ${attempt + 1}/${MAX_ATTEMPTS})`, err);
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleep(500 * (attempt + 1));
  }
  return null;
}

// Translates a chunk as one delimited request. If Google merges or drops a delimiter the chunk is
// halved and retried, so one awkward paragraph costs a few requests instead of one per paragraph.
// Items that can't be translated at all are handed to `onFailed`.
async function translateChunkGtx(
  chunk: TranslationPayload[],
  config: AppConfig,
  pauseRef: MutableRefObject<boolean>,
  onFailed: (items: TranslationPayload[]) => Promise<void>,
): Promise<TranslationResult[]> {
  if (pauseRef.current || chunk.length === 0) return [];

  const combined = await requestGtx(chunk.map(t => t.text).join(DELIMITER), config);
  if (combined === null) {
    // The service itself failed after retries; splitting would only multiply failing requests.
    await onFailed(chunk);
    return [];
  }
  if (chunk.length === 1) {
    return [{ id: chunk[0].id, translation: combined.trim() }];
  }

  const parts = combined.split(DELIMITER_RE).filter(p => p.trim() !== '');
  if (parts.length === chunk.length) {
    return chunk.map((item, i) => ({ id: item.id, translation: parts[i].trim() }));
  }

  console.warn(`Delimiter mismatch (expected ${chunk.length}, got ${parts.length}); splitting chunk`);
  const mid = Math.ceil(chunk.length / 2);
  const left = await translateChunkGtx(chunk.slice(0, mid), config, pauseRef, onFailed);
  const right = await translateChunkGtx(chunk.slice(mid), config, pauseRef, onFailed);
  return [...left, ...right];
}

// --- Entry point ---

// Translates a batch of paragraphs. Returns translations only for items that were actually
// translated; anything missing should stay in the original language.
export async function translateBatch(
  texts: TranslationPayload[],
  config: AppConfig,
  pauseRef: MutableRefObject<boolean>,
  context: TranslateContext = {},
): Promise<TranslationResult[]> {
  const results = new Map<number, string>();
  const fresh: [string, string][] = [];
  const llmNs = llmNamespace(config);
  const textById = new Map(texts.map(t => [t.id, t.text]));

  const record = (ns: string, translated: TranslationResult[]) => {
    for (const r of translated) {
      const source = textById.get(r.id);
      if (source === undefined || results.has(r.id)) continue;
      const translation = r.translation.trim();
      if (!translation || translation === source) continue;
      results.set(r.id, translation);
      fresh.push([cacheKey(ns, config, source), translation]);
    }
  };

  const runLlm = async (items: TranslationPayload[]) => {
    if (items.length === 0 || !llmAvailable(config)) return;
    try {
      record(llmNs, await translateWithLlm(items, config, context));
    } catch (err) {
      console.error("AI engine error", err);
      if (isFatal(err)) {
        llmBlockedUntil = Date.now() + LLM_PAUSE_MS;
        context.onLlmError?.(err as Error);
      }
    }
  };

  // 1. Translations from earlier runs.
  const namespaces = config.engine === 'llm' ? [llmNs]
    : config.engine === 'gtx-fallback' ? [GTX_NS, llmNs]
    : [GTX_NS];
  let pending = texts;
  for (const ns of namespaces) {
    if (pending.length === 0) break;
    const hits = await getCachedTranslations(pending.map(t => cacheKey(ns, config, t.text)));
    pending = pending.filter((t, i) => {
      if (hits[i]) {
        results.set(t.id, hits[i]!);
        return false;
      }
      return true;
    });
  }

  // 2. The AI model as the primary engine.
  if (config.engine === 'llm') {
    await runLlm(pending);
    pending = pending.filter(t => !results.has(t.id));
  }

  // 3. Google Translate for the rest: primary engine, or the safety net for the model.
  const onGtxFailed = async (items: TranslationPayload[]) => {
    if (config.engine === 'gtx-fallback') await runLlm(items);
  };
  for (const chunk of chunkByChars(pending)) {
    if (pauseRef.current) break;
    record(GTX_NS, await translateChunkGtx(chunk, config, pauseRef, onGtxFailed));
    await sleep(300); // spacing between requests keeps Google from rate limiting us
  }

  await setCachedTranslations(fresh);
  return texts
    .filter(t => results.has(t.id))
    .map(t => ({ id: t.id, translation: results.get(t.id)! }));
}
