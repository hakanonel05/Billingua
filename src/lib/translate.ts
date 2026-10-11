import type { MutableRefObject } from 'react';
import type { AppConfig, SimplifyLevel, TranslationPayload, TranslationResult } from '../types';
import { getCachedTranslations, setCachedTranslations } from './db';
import { isFatal, isLlmConfigured, mapParagraphs, LLM_PRESETS, type LlmError } from './llm';

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
  // Told when an AI service fails for good (server down, bad key, quota), and which service takes
  // over (undefined: Google Translate), so the UI can say so.
  onLlmError?: (err: Error, nextService?: string) => void;
}

const MAX_CHARS = 2000;
const DELIMITER = '\n\n|||\n\n';
const DELIMITER_RE = /(?:\s*\|\|\|\s*)+/;
const LLM_PAUSE_MS = 60_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// After a fatal error (server down, quota) a service is skipped for a while instead of failing
// once per batch. Tracked per service and model, so one spent quota doesn't stop the others.
const blockedUntil = new Map<string, number>();
const serviceKey = (c: AppConfig) => `${c.llmBaseUrl.trim()}|${c.llmModel.trim()}`;
const isAvailable = (c: AppConfig) => (blockedUntil.get(serviceKey(c)) ?? 0) <= Date.now();

// The selected AI service first, then every other cloud service the user saved a key for (with that
// service's default model): when one runs out of quota the next AI takes over before Google does.
export const llmCandidates = (config: AppConfig): AppConfig[] => {
  const candidates = [config];
  for (const preset of LLM_PRESETS) {
    const key = config.llmKeys?.[preset.id]?.trim();
    if (!preset.needsKey || !preset.model || !key || preset.id === config.llmProvider) continue;
    candidates.push({ ...config, llmProvider: preset.id, llmBaseUrl: preset.baseUrl, llmModel: preset.model, llmApiKey: key });
  }
  return candidates.filter(isLlmConfigured);
};

// Whether any AI service can be used right now.
export const hasUsableLlm = (config: AppConfig) => llmCandidates(config).some(isAvailable);

const serviceName = (c: AppConfig) => `${LLM_PRESETS.find(p => p.id === c.llmProvider)?.name.split(' — ')[0] ?? c.llmBaseUrl} (${c.llmModel})`;

// Runs `task` on the first AI service that works. A service failing for good (quota, bad key,
// server down) is skipped for as long as it said, the next one is tried, and `onLlmError` hears
// what happened and who takes over (undefined: nobody, Google Translate). Other errors end the
// attempt; whatever succeeded is kept by the caller.
async function withLlmFallback<T>(
  config: AppConfig,
  context: TranslateContext,
  task: (service: AppConfig) => Promise<T>,
): Promise<T | undefined> {
  const services = llmCandidates(config).filter(isAvailable);
  for (let i = 0; i < services.length; i++) {
    try {
      return await task(services[i]);
    } catch (err) {
      console.error("AI engine error", err);
      if (!isFatal(err)) return undefined;
      // A daily quota stays exhausted for hours: skip the service for as long as it said.
      blockedUntil.set(serviceKey(services[i]), Date.now() + Math.max(LLM_PAUSE_MS, (err as LlmError).retryAfterMs ?? 0));
      const next = services.slice(i + 1).find(isAvailable);
      context.onLlmError?.(err as Error, next ? serviceName(next) : undefined);
    }
  }
  return undefined;
}

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
// "d1": translations refined from a Google draft (kept apart from older from-scratch results).
const llmNamespace = (config: AppConfig) =>
  `llm-d1:${hash(config.llmBaseUrl.trim())}:${config.llmModel.trim()}:${config.tone}:${hash(config.customGlossary || '')}`;
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
  drafts: Map<number, string> = new Map(),
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
    `- Read the source in its own variety of English: in British English a "torch" is a flashlight, "trainers" are sneakers, a "flat" is an apartment.`,
    `- Render hesitations and interjections (er, um, mm, oh) with their natural ${target} equivalents instead of copying them.`,
    `- Translate every sentence completely: never summarize, merge or split paragraphs, and never add notes or explanations.`,
    `- Maintain a literary tone for fiction and a clear tone for non-fiction.`,
  );
  if (config.targetLang.startsWith('tr')) {
    lines.push('- Choose "sen" or "siz" from the relationship between the speakers and keep that choice for the same pair of characters, also within a single paragraph (do not switch from "geldin" to "sizi").');
  }
  if (config.tone !== 'default') lines.push(`- Use a ${config.tone} tone.`);
  if (context.names?.length) lines.push(`- Keep these names exactly as written: ${context.names.join(', ')}.`);
  if (drafts.size) {
    lines.push(`- Items come with "draft", a machine translation. It is often literal and sometimes wrong: use it only as a reference for the meaning. Fix mistranslations, word-for-word idioms, wrong word senses, unnatural word order and leftover English words. Give your own final, polished translation of "text", not a comment on the draft.`);
  }
  if (config.customGlossary) lines.push(`Follow these glossary rules:\n${config.customGlossary}`);

  // Earlier source paragraphs with the translations already chosen for them; the source alone
  // when nothing has been translated yet.
  let contextBlock: string | string[] = context.precedingText || [];
  if (context.previousPairs?.length) {
    contextBlock = 'The previous passage and how it was translated, for consistency only (do not include it in the output):\n"""\n'
      + context.previousPairs.map(p => `${p.source}\n=> ${p.translation}`).join('\n\n')
      + '\n"""';
  }

  const items = texts.map(t => (drafts.has(t.id) ? { ...t, draft: drafts.get(t.id) } : t));
  const translated = await mapParagraphs(config, lines.join('\n'), items, contextBlock);
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
  if (llmCandidates(config).length === 0) throw new Error('Metni sadeleştirmek için bir yapay zeka sunucusu ve model seçin.');

  // Earlier rewrites by any of the services.
  let pending = texts;
  for (const service of llmCandidates(config)) {
    const ns = simplifyNamespace(service, level);
    const hits = await getCachedTranslations(pending.map(t => `${ns}|${t.text}`));
    pending = pending.filter((t, i) => {
      if (hits[i]) results.set(t.id, hits[i]!);
      return !hits[i];
    });
  }
  if (pending.length === 0) return results;

  let instruction = `You rewrite fiction and non-fiction for English learners at CEFR level ${level}. Rewrite the text in simpler English. ${SIMPLIFY_GUIDE[level]} Keep every event, fact, line of dialogue and name, in the same order; do not summarize, shorten the story or add anything. Keep quotation marks around dialogue.`;
  if (context.names?.length) instruction += ` Keep these names exactly as written: ${context.names.join(', ')}.`;

  let lastError: unknown;
  const done = await withLlmFallback(config, {
    ...context,
    onLlmError: (err, next) => { lastError = err; context.onLlmError?.(err, next); },
  }, async service => {
    const rewritten = await mapParagraphs(service, instruction, pending, context.precedingText);
    const ns = simplifyNamespace(service, level);
    const fresh: [string, string][] = [];
    rewritten.forEach((text, id) => {
      results.set(id, text);
      fresh.push([`${ns}|${pending.find(t => t.id === id)!.text}`, text]);
    });
    await setCachedTranslations(fresh);
    return true;
  });
  // Simplifying has no Google fallback: when every AI service is out, stop and say why.
  if (!done && lastError) throw lastError;
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
  const llmNamespaces = llmCandidates(config).map(llmNamespace);
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

  const runLlm = async (items: TranslationPayload[], drafts?: Map<number, string>) => {
    if (items.length === 0) return;
    await withLlmFallback(config, context, async service => {
      record(llmNamespace(service), await translateWithLlm(items, service, context, drafts));
    });
  };

  // 1. Translations from earlier runs.
  const namespaces = config.engine === 'llm' ? llmNamespaces
    : config.engine === 'gtx-fallback' ? [GTX_NS, ...llmNamespaces]
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

  // 2. The AI model as the primary engine: Google drafts first (fast, free, usually right about
  // the meaning), then the model turns them into natural, consistent prose. Paragraphs the model
  // can't do keep their Google draft.
  if (config.engine === 'llm' && pending.length) {
    const drafts = new Map<number, string>();
    for (const chunk of chunkByChars(pending)) {
      if (pauseRef.current) break;
      for (const r of await translateChunkGtx(chunk, config, pauseRef, async () => {})) drafts.set(r.id, r.translation);
    }
    await runLlm(pending, drafts);
    record(GTX_NS, pending.filter(t => drafts.has(t.id)).map(t => ({ id: t.id, translation: drafts.get(t.id)! })));
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
