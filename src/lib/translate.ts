import type { MutableRefObject } from 'react';
import { GoogleGenAI, Type } from '@google/genai';
import type { AppConfig, TranslationPayload, TranslationResult } from '../types';
import { getCachedTranslations, setCachedTranslations } from './db';

export interface TranslateContext {
  // Source paragraphs right before this batch, so the model knows who "he" is (Gemini only).
  precedingText?: string[];
  // Recurring character/place names that must stay unchanged (Gemini only).
  names?: string[];
}

const MAX_CHARS = 2000;
const DELIMITER = '\n\n|||\n\n';
const DELIMITER_RE = /(?:\s*\|\|\|\s*)+/;
const GEMINI_QUOTA_PAUSE_MS = 60_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const isQuotaError = (err: unknown) => /429|quota|RESOURCE_EXHAUSTED/i.test((err as any)?.message || String(err));

// After a quota error Gemini is skipped for a while instead of failing once per batch.
let geminiBlockedUntil = 0;
const geminiAvailable = (config: AppConfig) => !!config.apiKey && Date.now() >= geminiBlockedUntil;

// Set once the /api proxy answers 404 (static hosting), so later requests go straight to Google.
let proxyMissing = false;

// --- Cache keys ---
// Each engine writes under its own namespace, so a Google fallback result never masquerades as a
// Gemini translation on the next run, and Gemini results depend on the settings that shape them.

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

const GTX_NS = 'gtx';
const geminiNamespace = (config: AppConfig) =>
  `gemini:${config.geminiModel}:${config.tone}:${hash(config.customGlossary || '')}`;
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

// --- Gemini ---

export async function translateWithGemini(
  texts: TranslationPayload[],
  config: AppConfig,
  context: TranslateContext = {},
): Promise<TranslationResult[]> {
  const ai = new GoogleGenAI({ apiKey: config.apiKey });
  const source = config.sourceLang === 'auto' ? 'the detected language' : `the language with code "${config.sourceLang}"`;

  const prompt = [
    `Translate each "text" from ${source} into the language with code "${config.targetLang}". Return exactly one item per input, with the same "id".`,
  ];
  if (context.precedingText?.length) {
    prompt.push(`The passage just before these texts, for context only (do not translate it):\n"""\n${context.precedingText.join('\n\n')}\n"""`);
  }
  prompt.push(JSON.stringify(texts));

  let systemInstruction = 'You are a professional book translator. Translate the given JSON array of texts faithfully and completely; never summarize, merge items or add notes. Maintain literary tone for fiction, and clear tone for non-fiction. Never change the IDs.';
  if (config.tone !== 'default') systemInstruction += ` Use a ${config.tone} tone for the translation.`;
  if (context.names?.length) systemInstruction += `\n\nKeep these names exactly as written: ${context.names.join(', ')}.`;
  if (config.customGlossary) systemInstruction += `\n\nUse the following custom glossary rules:\n${config.customGlossary}`;

  const response = await ai.models.generateContent({
    model: config.geminiModel || 'gemini-3-flash-preview',
    contents: prompt.join('\n\n'),
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.NUMBER },
            translation: { type: Type.STRING }
          },
          required: ["id", "translation"]
        }
      }
    }
  });

  if (!response.text) throw new Error("Empty response from Gemini");
  let text = response.text.trim();
  if (text.startsWith('```json')) text = text.replace(/^```json\n/, '').replace(/\n```$/, '');
  if (text.startsWith('```')) text = text.replace(/^```\n/, '').replace(/\n```$/, '');
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("Gemini response is not an array");

  // Drop anything that doesn't answer one of our ids; missing ids fall through to Google Translate.
  const wanted = new Set(texts.map(t => t.id));
  return parsed.filter((r: any) =>
    r && wanted.has(r.id) && typeof r.translation === 'string' && r.translation.trim() !== ''
  );
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
  const geminiNs = geminiNamespace(config);
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

  const runGemini = async (items: TranslationPayload[]) => {
    if (items.length === 0 || !geminiAvailable(config)) return;
    try {
      record(geminiNs, await translateWithGemini(items, config, context));
    } catch (err) {
      console.error("Gemini API error", err);
      if (isQuotaError(err)) geminiBlockedUntil = Date.now() + GEMINI_QUOTA_PAUSE_MS;
    }
  };

  // 1. Translations from earlier runs.
  const namespaces = config.engine === 'gemini' ? [geminiNs]
    : config.engine === 'gtx-fallback' ? [GTX_NS, geminiNs]
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

  // 2. Gemini as the primary engine.
  if (config.engine === 'gemini') {
    await runGemini(pending);
    pending = pending.filter(t => !results.has(t.id));
  }

  // 3. Google Translate for the rest: primary engine, or the safety net for Gemini.
  const onGtxFailed = async (items: TranslationPayload[]) => {
    if (config.engine === 'gtx-fallback') await runGemini(items);
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
