import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '../types';

const generateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent }; },
  Type: { ARRAY: 'ARRAY', OBJECT: 'OBJECT', NUMBER: 'NUMBER', STRING: 'STRING' },
}));

const { translateBatch, chunkByChars } = await import('./translate');

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  sourceLang: 'en', targetLang: 'tr', layout: 'side-by-side', engine: 'gtx',
  geminiModel: 'gemini-3-flash-preview', apiKey: '', buildGlossary: false,
  customBg: '', customColor: '', minCefrLevel: 'B1', extractIdioms: false,
  contextualGlossary: false, tone: 'default', customGlossary: '',
  fontFamily: 'serif', fontSize: '1em', lineSpacing: '1.5', ...overrides,
});

const notPaused = { current: false };

// Fake proxy: "translates" by upper-casing; `mangle` lets a test break the delimiters.
const installProxy = (mangle: (text: string) => string = t => t) => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const { text } = JSON.parse(String(init?.body));
    requests.push(text);
    return new Response(JSON.stringify({ translation: mangle(text).toUpperCase() }), { status: 200 });
  }));
  return requests;
};

beforeEach(() => {
  vi.unstubAllGlobals();
  generateContent.mockReset();
});

describe('chunkByChars', () => {
  it('keeps chunks under the limit', () => {
    const items = [0, 1, 2].map(id => ({ id, text: 'x'.repeat(40) }));
    expect(chunkByChars(items, 100).map(c => c.length)).toEqual([2, 1]);
  });
});

describe('translateBatch with Google Translate', () => {
  it('translates a chunk in one request', async () => {
    const requests = installProxy();
    const out = await translateBatch([{ id: 1, text: 'one' }, { id: 2, text: 'two' }], config(), notPaused);
    expect(out).toEqual([{ id: 1, translation: 'ONE' }, { id: 2, translation: 'TWO' }]);
    expect(requests).toHaveLength(1);
  });

  it('splits the chunk when the delimiters come back merged', async () => {
    // Google glues the first two items together whenever all three are sent at once
    const requests = installProxy(t => (t.split('|||').length === 3 ? t.replace(/\s*\|\|\|\s*/, ' ') : t));
    const items = [{ id: 1, text: 'one' }, { id: 2, text: 'two' }, { id: 3, text: 'three' }];
    const out = await translateBatch(items, config(), notPaused);
    expect(out.map(r => r.translation)).toEqual(['ONE', 'TWO', 'THREE']);
    // the full chunk, then its two halves: not one request per item
    expect(requests).toHaveLength(3);
  });

  it('leaves items untranslated when the translation equals the source', async () => {
    installProxy(t => t.toLowerCase());
    const out = await translateBatch([{ id: 1, text: 'OK' }, { id: 2, text: 'fine' }], config(), notPaused);
    expect(out).toEqual([{ id: 2, translation: 'FINE' }]);
  });
});

describe('translateBatch with Gemini', () => {
  it('sends context and names, and fills ids Gemini skipped from Google Translate', async () => {
    const requests = installProxy();
    generateContent.mockResolvedValue({ text: JSON.stringify([{ id: 1, translation: 'bir' }, { id: 99, translation: 'junk' }]) });

    const out = await translateBatch(
      [{ id: 1, text: 'one' }, { id: 2, text: 'two' }],
      config({ engine: 'gemini', apiKey: 'test-key' }),
      notPaused,
      { precedingText: ['Earlier paragraph.'], names: ['Ishmael'] },
    );

    expect(out).toEqual([{ id: 1, translation: 'bir' }, { id: 2, translation: 'TWO' }]);
    expect(requests).toEqual(['two']);
    const call = generateContent.mock.calls[0][0];
    expect(call.contents).toContain('Earlier paragraph.');
    expect(call.config.systemInstruction).toContain('Ishmael');
  });
});
