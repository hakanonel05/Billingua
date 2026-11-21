import type { MutableRefObject } from 'react';
import type { AppConfig, SimplifyLevel, TranslationPayload, TranslationResult } from '../types';
import { getCachedTranslations, setCachedTranslations } from './db';
import { isFatal, isLlmConfigured, mapParagraphs, batchSizeOf, LLM_PRESETS, type LlmError } from './llm';
import { loadRankTable, textDifficulty } from './cefr';

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
  // Estimated CEFR level of the original, for the simplifier (AI engine only).
  bookLevel?: string;
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
// `quota`: blocked by a rate limit, which clears by waiting (a bad key or a down server doesn't).
const blocked = new Map<string, { until: number; quota: boolean }>();
const serviceKey = (c: AppConfig) => `${c.llmBaseUrl.trim()}|${c.llmModel.trim()}`;
const isAvailable = (c: AppConfig) => (blocked.get(serviceKey(c))?.until ?? 0) <= Date.now();

// Every AI service and model that may translate, in order: the selected model, the selected
// service's other models (quotas are counted per model), then every other cloud service the user
// saved a key for with its models. When one runs out of quota the next takes over before Google does.
export const llmCandidates = (config: AppConfig): AppConfig[] => {
  const withModels = (base: AppConfig, models: (string | undefined)[]) =>
    [...new Set(models.filter((m): m is string => !!m?.trim()))].map(llmModel => ({ ...base, llmModel }));

  const selected = LLM_PRESETS.find(p => p.id === config.llmProvider);
  const candidates = withModels(config, [config.llmModel, ...(selected?.backupModels ?? [])]);
  for (const preset of LLM_PRESETS) {
    const key = config.llmKeys?.[preset.id]?.trim();
    if (!preset.needsKey || !preset.model || !key || preset.id === config.llmProvider) continue;
    const base = { ...config, llmProvider: preset.id, llmBaseUrl: preset.baseUrl, llmModel: preset.model, llmApiKey: key };
    candidates.push(...withModels(base, [preset.model, ...(preset.backupModels ?? [])]));
  }
  return candidates.filter(isLlmConfigured);
};

// When the first AI service that ran out of quota gets it back (ms since epoch), or null if none did.
export const llmAvailableAt = (config: AppConfig): number | null => {
  const times = llmCandidates(config)
    .map(c => blocked.get(serviceKey(c)))
    .filter(b => b?.quota && b.until > Date.now())
    .map(b => b!.until);
  return times.length ? Math.min(...times) : null;
};

// Thrown in "wait" mode when every AI service is out of quota: the job pauses until `resumeAt`
// instead of finishing the book with Google Translate.
export class QuotaWaitError extends Error {
  constructor(readonly resumeAt: number) {
    super('Bütün yapay zeka kotaları doldu.');
  }
}

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
      blocked.set(serviceKey(services[i]), {
        until: Date.now() + Math.max(LLM_PAUSE_MS, (err as LlmError).retryAfterMs ?? 0),
        quota: (err as LlmError).status === 429,
      });
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
  `llm-d1:${hash(config.llmBaseUrl.trim())}:${config.llmModel.trim()}:${config.tone}:${hash(config.customGlossary || '')}`
  + (config.translationStyle === 'learner' ? ':learner' : '');
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

// Translates with one AI service, in requests of that service's batch size. Each request after the
// first sees how the paragraphs just before it were translated. `onResults` hears each request's
// results as they arrive, so a quota that runs out half-way keeps what was already done.
export async function translateWithLlm(
  texts: TranslationPayload[],
  config: AppConfig,
  context: TranslateContext = {},
  drafts: Map<number, string> = new Map(),
  onResults?: (results: TranslationResult[]) => void,
): Promise<TranslationResult[]> {
  const target = languageName(config.targetLang);
  const source = config.sourceLang === 'auto' ? 'English' : languageName(config.sourceLang);
  const learner = config.translationStyle === 'learner';
  const lines = [learner
    ? `You translate from ${languageName(config.sourceLang)} into ${target} for a ${target} speaker who is learning ${source}. The reader reads the original and your translation side by side and uses the translation to understand the original sentence by sentence, word by word.`
    : `You are an experienced literary translator from ${languageName(config.sourceLang)} into ${target}.`];
  if (context.book?.title) {
    lines.push(`You are translating the book "${context.book.title}"${context.book.author ? ` by ${context.book.author}` : ''}.`);
  }
  if (learner) lines.push(
    `Write a faithful learner's translation, not a literary one:`,
    `- Keep the same sentences in the same order: one ${target} sentence for each sentence of the original. Never merge, split or reorder sentences.`,
    `- Stay as close to the original wording and structure as correct ${target} grammar allows, so the reader can match each part of the sentence. Do not paraphrase, embellish or rephrase for style.`,
    `- Translate each word with its most common, plain meaning, using everyday ${target} words rather than literary or rare ones. Keep the original's tenses where ${target} allows it.`,
    `- Idioms and phrasal verbs ("give up", "ran into", "it's raining cats and dogs") cannot be translated word for word: give their meaning plainly.`,
    `- Read the source in its own variety of English: in British English a "torch" is a flashlight, "trainers" are sneakers, a "flat" is an apartment.`,
    `- Keep the dialogue quotation marks of the original, and keep names, recurring terms and forms of address consistent with the previous passage.`,
    `- Translate every sentence completely: leave nothing out, add nothing, and never add notes or explanations.`,
  );
  else lines.push(
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
    lines.push(learner
      ? `- Items come with "draft", a machine translation. Its closeness to the original is often right for this reader; keep its structure where it is correct, and fix mistranslations, word-for-word idioms, wrong word senses, grammar errors and leftover English words. Give your own final translation of "text", not a comment on the draft.`
      : `- Items come with "draft", a machine translation. It is often literal and sometimes wrong: use it only as a reference for the meaning. Fix mistranslations, word-for-word idioms, wrong word senses, unnatural word order and leftover English words. Give your own final, polished translation of "text", not a comment on the draft.`);
  }
  if (config.customGlossary) lines.push(`Follow these glossary rules:\n${config.customGlossary}`);

  // Earlier source paragraphs with the translations already chosen for them; the source alone
  // when nothing has been translated yet.
  const contextFor = (pairs: { source: string; translation: string }[] | undefined, preceding: string[]): string | string[] =>
    pairs?.length
      ? 'The previous passage and how it was translated, for consistency only (do not include it in the output):\n"""\n'
        + pairs.map(p => `${p.source}\n=> ${p.translation}`).join('\n\n')
        + '\n"""'
      : preceding;

  const instruction = lines.join('\n');
  const batchSize = batchSizeOf(config);
  const all: TranslationResult[] = [];
  let pairs = context.previousPairs;
  let preceding = context.precedingText || [];
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const items = batch.map(t => (drafts.has(t.id) ? { ...t, draft: drafts.get(t.id) } : t));
    const translated = await mapParagraphs(config, instruction, items, contextFor(pairs, preceding));
    const results = Array.from(translated, ([id, translation]) => ({ id, translation }));
    all.push(...results);
    onResults?.(results);
    const tail = batch.slice(-3);
    pairs = tail.filter(t => translated.has(t.id)).map(t => ({ source: t.text, translation: translated.get(t.id)! }));
    preceding = tail.map(t => t.text);
  }
  return all;
}

// --- Simplification (graded-reader rewrite) ---

const SIMPLIFY_GUIDE: Record<Exclude<SimplifyLevel, 'off'>, string> = {
  A2: 'Use only very common everyday words and short simple sentences (present and past simple, "and", "but", "because").',
  B1: 'Use common vocabulary and mostly simple or compound sentences; replace rare and literary words with everyday ones.',
  B2: 'Keep a natural style but replace rare, archaic or literary words and untangle very long sentences.',
};

const simplifyNamespace = (config: AppConfig, level: SimplifyLevel) =>
  `simplify:${level}:${hash(config.llmBaseUrl.trim())}:${config.llmModel.trim()}`;

// Rewrites from earlier runs, by any of the services (id -> rewrite).
export async function cachedSimplifications(
  texts: TranslationPayload[],
  config: AppConfig,
  level: SimplifyLevel,
): Promise<Map<number, string>> {
  const results = new Map<number, string>();
  let pending = texts;
  for (const service of llmCandidates(config)) {
    if (pending.length === 0) break;
    const ns = simplifyNamespace(service, level);
    const hits = await getCachedTranslations(pending.map(t => `${ns}|${t.text}`));
    pending = pending.filter((t, i) => {
      if (hits[i]) results.set(t.id, hits[i]!);
      return !hits[i];
    });
  }
  return results;
}

// Rewrites English paragraphs at a lower CEFR level with the AI engine. Returns rewrites only for
// paragraphs that were rewritten; the rest stay as they are. Fatal model errors are thrown.
// Paragraphs go out in requests of the service's batch size, each request's results are cached as
// they arrive, so a quota running out half-way keeps what was done.
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
  (await cachedSimplifications(texts, config, level)).forEach((text, id) => results.set(id, text));
  const pending = texts.filter(t => !results.has(t.id));
  if (pending.length === 0) return results;

  let instruction = `You rewrite fiction and non-fiction for English learners at CEFR level ${level}. Rewrite the text in simpler English. ${SIMPLIFY_GUIDE[level]} Keep every event, fact, line of dialogue and name, in the same order; do not summarize, shorten the story or add anything. Keep quotation marks around dialogue.`;
  if (context.book?.title) instruction += ` The text comes from "${context.book.title}"${context.book.author ? ` by ${context.book.author}` : ''}.`;
  if (context.bookLevel) instruction += ` The original is written at about level ${context.bookLevel}.`;
  if (context.names?.length) instruction += ` Keep these names exactly as written: ${context.names.join(', ')}.`;
  // The words a frequency analysis rates above the level in a batch: the ones most worth replacing.
  const table = await loadRankTable();
  const instructionFor = (batch: TranslationPayload[]) => {
    const hardWords = [...new Set(batch.flatMap(t => textDifficulty(t.text, level, table).hardWords))]
      .filter(w => !context.names?.some(n => n.toLowerCase() === w))
      .slice(0, 60);
    return hardWords.length
      ? `${instruction} These words in the texts are probably above ${level}: ${hardWords.join(', ')}. Replace them with common words, or explain them briefly in simple words when there is no simple equivalent.`
      : instruction;
  };

  let lastError: unknown;
  const done = await withLlmFallback(config, {
    ...context,
    onLlmError: (err, next) => { lastError = err; context.onLlmError?.(err, next); },
  }, async service => {
    // Each service starts from what the previous ones left undone, in its own batch size.
    const remaining = pending.filter(t => !results.has(t.id));
    const ns = simplifyNamespace(service, level);
    const size = batchSizeOf(service);
    for (let start = 0; start < remaining.length; start += size) {
      const batch = remaining.slice(start, start + size);
      const preceding = start === 0 ? context.precedingText : remaining.slice(Math.max(0, start - 3), start).map(t => t.text);
      const rewritten = await mapParagraphs(service, instructionFor(batch), batch, preceding);
      const fresh: [string, string][] = [];
      rewritten.forEach((text, id) => {
        results.set(id, text);
        fresh.push([`${ns}|${batch.find(t => t.id === id)!.text}`, text]);
      });
      await setCachedTranslations(fresh);
    }
    return true;
  });
  // Simplifying has no Google fallback: when every AI service is out of quota, pause until the
  // first one is back; for any other failure (bad key, server down) stop and say why.
  if (!done && lastError) {
    const resumeAt = llmAvailableAt(config);
    if ((lastError as LlmError).status === 429 && resumeAt && !hasUsableLlm(config)) throw new QuotaWaitError(resumeAt);
    throw lastError;
  }
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

  // Each service starts from what the previous ones left untranslated.
  const runLlm = async (items: TranslationPayload[], drafts?: Map<number, string>) => {
    if (items.length === 0) return;
    await withLlmFallback(config, context, async service => {
      const remaining = items.filter(t => !results.has(t.id));
      if (remaining.length) await translateWithLlm(remaining, service, context, drafts, r => record(llmNamespace(service), r));
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
    // "wait" (default): when every AI service is out of quota, pause until one is back instead of
    // finishing the book with Google Translate, which has no context.
    const waitForQuota = config.whenQuotaRunsOut !== 'google' && llmCandidates(config).length > 0;
    const pauseIfOutOfQuota = async () => {
      const resumeAt = llmAvailableAt(config);
      if (waitForQuota && !hasUsableLlm(config) && resumeAt) {
        await setCachedTranslations(fresh); // keep what the AI already did
        throw new QuotaWaitError(resumeAt);
      }
    };
    await pauseIfOutOfQuota();

    const drafts = new Map<number, string>();
    for (const chunk of chunkByChars(pending)) {
      if (pauseRef.current) break;
      for (const r of await translateChunkGtx(chunk, config, pauseRef, async () => {})) drafts.set(r.id, r.translation);
    }
    await runLlm(pending, drafts);
    if (pending.some(t => !results.has(t.id))) await pauseIfOutOfQuota();
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
