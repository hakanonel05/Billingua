import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '../types';
import { translateBatch, simplifyBatch, chunkByChars } from './translate';
import { parseJsonReply, mapParagraphs, LlmError, isFatal } from './llm';

const config = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  sourceLang: 'en', targetLang: 'tr', layout: 'side-by-side', engine: 'gtx',
  llmProvider: 'ollama', llmBaseUrl: 'http://localhost:11434/v1', llmModel: 'test-model', llmApiKey: '',
  simplifyLevel: 'off', buildGlossary: false,
  customBg: '', customColor: '', minCefrLevel: 'B1', extractIdioms: false,
  contextualGlossary: false, tone: 'default', customGlossary: '',
  fontFamily: 'serif', fontSize: '1em', lineSpacing: '1.5', ...overrides,
});

const notPaused = { current: false };

interface ChatCall { url: string; body: any }

// Fake network: the Google proxy upper-cases text (`mangle` can break its delimiters), and an
// OpenAI-compatible server answers with `llmReply(body)`.
const installNetwork = ({
  mangle = (t: string) => t,
  llmReply,
}: { mangle?: (t: string) => string; llmReply?: (body: any) => string | Response } = {}) => {
  const gtx: string[] = [];
  const llm: ChatCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (url.endsWith('/chat/completions')) {
      llm.push({ url, body });
      const reply = llmReply ? llmReply(body) : '';
      if (reply instanceof Response) return reply;
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 });
    }
    gtx.push(body.text);
    return new Response(JSON.stringify({ translation: mangle(body.text).toUpperCase() }), { status: 200 });
  }));
  return { gtx, llm };
};

// A model that answers JSON batches and plain single paragraphs with `fn(text)`.
const modelThat = (fn: (text: string) => string, { skipIds = [] as number[] } = {}) => (body: any) => {
  const user: string = body.messages[1].content;
  if (body.response_format) {
    const { items } = JSON.parse(user.slice(user.indexOf('{"items"')));
    return JSON.stringify({ items: items.filter((i: any) => !skipIds.includes(i.id)).map((i: any) => ({ id: i.id, text: fn(i.text) })) });
  }
  return fn(user.split('"""\n\n').pop()!);
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('chunkByChars', () => {
  it('keeps chunks under the limit', () => {
    const items = [0, 1, 2].map(id => ({ id, text: 'x'.repeat(40) }));
    expect(chunkByChars(items, 100).map(c => c.length)).toEqual([2, 1]);
  });
});

describe('translateBatch with Google Translate', () => {
  it('translates a chunk in one request', async () => {
    const { gtx } = installNetwork();
    const out = await translateBatch([{ id: 1, text: 'one' }, { id: 2, text: 'two' }], config(), notPaused);
    expect(out).toEqual([{ id: 1, translation: 'ONE' }, { id: 2, translation: 'TWO' }]);
    expect(gtx).toHaveLength(1);
  });

  it('splits the chunk when the delimiters come back merged', async () => {
    // Google glues the first two items together whenever all three are sent at once
    const { gtx } = installNetwork({ mangle: t => (t.split('|||').length === 3 ? t.replace(/\s*\|\|\|\s*/, ' ') : t) });
    const items = [{ id: 1, text: 'one' }, { id: 2, text: 'two' }, { id: 3, text: 'three' }];
    const out = await translateBatch(items, config(), notPaused);
    expect(out.map(r => r.translation)).toEqual(['ONE', 'TWO', 'THREE']);
    // the full chunk, then its two halves: not one request per item
    expect(gtx).toHaveLength(3);
  });

  it('leaves items untranslated when the translation equals the source', async () => {
    installNetwork({ mangle: t => t.toLowerCase() });
    const out = await translateBatch([{ id: 1, text: 'OK' }, { id: 2, text: 'fine' }], config(), notPaused);
    expect(out).toEqual([{ id: 2, translation: 'FINE' }]);
  });
});

describe('translateBatch with an open-source model', () => {
  it('sends context and names, and fills paragraphs the model skipped', async () => {
    const { gtx, llm } = installNetwork({ llmReply: modelThat(t => `tr:${t}`, { skipIds: [2] }) });

    const out = await translateBatch(
      [{ id: 1, text: 'one' }, { id: 2, text: 'two' }],
      config({ engine: 'llm' }),
      notPaused,
      { precedingText: ['Earlier paragraph.'], names: ['Ishmael'] },
    );

    // the batch request, then a plain-text retry for the skipped paragraph
    expect(out).toEqual([{ id: 1, translation: 'tr:one' }, { id: 2, translation: 'tr:two' }]);
    expect(gtx).toEqual([]);
    expect(llm).toHaveLength(2);
    expect(llm[0].url).toBe('http://localhost:11434/v1/chat/completions');
    expect(llm[0].body.model).toBe('test-model');
    expect(llm[0].body.messages[1].content).toContain('Earlier paragraph.');
    expect(llm[0].body.messages[0].content).toContain('Ishmael');
    expect(llm[0].body.messages[0].content).toContain('Turkish');
  });

  it('falls back to Google and reports it when the server is down', async () => {
    let reported: Error | undefined;
    const { gtx } = installNetwork({ llmReply: () => { throw new TypeError('Failed to fetch'); } });
    const out = await translateBatch(
      [{ id: 1, text: 'one' }], config({ engine: 'llm', llmBaseUrl: 'http://localhost:9/v1' }), notPaused,
      { onLlmError: e => { reported = e; } },
    );
    expect(out).toEqual([{ id: 1, translation: 'ONE' }]);
    expect(gtx).toEqual(['one']);
    expect(reported?.message).toContain('ulaşılamadı');
  });
});

describe('simplifyBatch', () => {
  it('rewrites paragraphs at the requested level', async () => {
    const { llm } = installNetwork({ llmReply: modelThat(t => `simple ${t}`) });
    const out = await simplifyBatch(
      [{ id: 1, text: 'The ubiquitous fog enveloped the town.' }, { id: 2, text: 'It was ineffable.' }],
      config({ llmBaseUrl: 'http://simplify.test/v1' }), 'B1',
    );
    expect(out.get(1)).toBe('simple The ubiquitous fog enveloped the town.');
    expect(out.get(2)).toBe('simple It was ineffable.');
    expect(llm[0].body.messages[0].content).toContain('CEFR level B1');
  });

  it('does nothing when switched off', async () => {
    const { llm } = installNetwork();
    expect((await simplifyBatch([{ id: 1, text: 'x' }], config(), 'off')).size).toBe(0);
    expect(llm).toEqual([]);
  });

  it('refuses to run without a model', async () => {
    await expect(simplifyBatch([{ id: 1, text: 'x' }], config({ llmModel: '' }), 'B1')).rejects.toThrow('model');
  });
});

describe('llm helpers', () => {
  it('parses JSON wrapped in prose or code fences', () => {
    expect(parseJsonReply('```json\n{"items":[]}\n```')).toEqual({ items: [] });
    expect(parseJsonReply('Sure! Here it is: {"items":[{"id":1,"text":"a"}]} Hope it helps.')).toEqual({ items: [{ id: 1, text: 'a' }] });
  });

  it('retries one by one when the batch reply is not JSON', async () => {
    const { llm } = installNetwork({ llmReply: body => (body.response_format ? 'I cannot do JSON, sorry' : 'ok') });
    const out = await mapParagraphs(config(), 'Do it.', [{ id: 1, text: 'a' }, { id: 2, text: 'b' }]);
    expect(Array.from(out.values())).toEqual(['ok', 'ok']);
    expect(llm).toHaveLength(3);
  });

  it('stops at the first fatal error instead of trying every paragraph', async () => {
    const { llm } = installNetwork({ llmReply: () => new Response('no such model', { status: 404 }) });
    await expect(mapParagraphs(config(), 'Do it.', [{ id: 1, text: 'a' }, { id: 2, text: 'b' }])).rejects.toBeInstanceOf(LlmError);
    expect(llm).toHaveLength(1);
    expect(isFatal(new LlmError('x', 429))).toBe(true);
    expect(isFatal(new LlmError('x', 500))).toBe(false);
  });
});
