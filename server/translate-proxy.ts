// Google Translate from Node, where the browser's CORS rules don't apply. Used by the web server
// (server.ts, /api/process-text) and by the desktop app (electron/main.ts). Tries several public
// endpoints in turn and throws only when all of them fail.

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const fetchWithTimeout = async (url: string, init: RequestInit, ms: number) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
};

class RateLimited extends Error {}

const joinSegments = (data: any): string => {
  let translated = '';
  if (data && data[0]) {
    data[0].forEach((s: any) => { if (s[0]) translated += s[0]; });
  }
  return translated;
};

// Method 1: Google Translate API (free endpoint), rotating clients and retrying on 429/503.
async function tryGtxPost(t: string, sl: string, tl: string, retryCount = 0): Promise<string> {
  const clients = ['gtx', 't', 'at', 'dict-chrome-ex'];
  const client = clients[retryCount % clients.length];
  const url = `https://translate.googleapis.com/translate_a/single?client=${client}&sl=${sl}&tl=${tl}&dt=t&ie=UTF-8&oe=UTF-8`;
  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        'Referer': 'https://translate.google.com/',
      },
      body: `q=${encodeURIComponent(t)}`,
    }, 10000);

    // A 429 means this IP is rate limited: other clients won't help, the other methods might.
    if (response.status === 429) throw new RateLimited(`GTX POST ${client} returned 429`);
    if (response.status === 503 && retryCount < 3) {
      const delay = 1000 * (retryCount + 1);
      console.warn(`GTX POST ${client} failed (503). Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return tryGtxPost(t, sl, tl, retryCount + 1);
    }
    if (!response.ok) throw new Error(`GTX POST ${client} returned ${response.status}`);
    return joinSegments(await response.json());
  } catch (e) {
    if (!(e instanceof RateLimited) && retryCount < 3) return tryGtxPost(t, sl, tl, retryCount + 1);
    throw e;
  }
}

// Method 2: RPC-like endpoint
async function tryGtxRpc(t: string, sl: string, tl: string): Promise<string> {
  const url = `https://translate.google.com/translate_a/t?client=webapp&sl=${sl}&tl=${tl}&v=1.0&source=bh&tk=1&q=${encodeURIComponent(t)}`;
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': USER_AGENT, 'Referer': 'https://translate.google.com/' },
  }, 10000);
  if (!response.ok) throw new Error(`GTX RPC returned ${response.status}`);
  const data = await response.json();
  return Array.isArray(data) ? data.join('') : data;
}

// Method 3: Standard GTX via GET
async function tryGtxGet(t: string, sl: string, tl: string): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(t)}`;
  const response = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, 10000);
  if (!response.ok) throw new Error(`GTX GET returned ${response.status}`);
  return joinSegments(await response.json());
}

// Method 4: BatchExecute (official web UI endpoint)
async function tryBatchExecute(t: string, sl: string, tl: string): Promise<string> {
  const url = 'https://translate.google.com/_/TranslateWebserverUi/data/batchexecute';
  const innerData = JSON.stringify([[t, sl, tl, true], [null]]);
  const freq = JSON.stringify([[["MkEWBc", innerData, null, "generic"]]]);
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': USER_AGENT },
    body: `f.req=${encodeURIComponent(freq)}`,
  }, 15000);
  if (!response.ok) throw new Error(`BatchExecute returned ${response.status}`);

  const rawText = await response.text();
  try {
    const jsonStart = rawText.indexOf('\n[[');
    if (jsonStart !== -1) {
      const envelope = JSON.parse(rawText.substring(jsonStart));
      const data = JSON.parse(envelope[0][2]);
      // The structure is deeply nested: data[1][0][0][5] or data[1][0][0][0]
      if (data && data[1] && data[1][0] && data[1][0][0]) {
        const result = data[1][0][0];
        if (Array.isArray(result[5])) return result[5].map((s: any) => s[0]).join('');
        return result[0];
      }
    }
    for (const rpc of ['wM3Wdb', 'MkEWBc']) {
      const match = rawText.match(new RegExp(`\\[\\["${rpc}","\\[\\\\"(.*?)\\\\"`));
      if (match && match[1]) return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  } catch (e) {
    console.error("BatchExecute parsing error:", e);
  }
  throw new Error("Could not parse BatchExecute response");
}

const METHODS: [string, (t: string, sl: string, tl: string) => Promise<string>][] = [
  ['GTX POST', tryGtxPost],
  ['GTX RPC', tryGtxRpc],
  ['GTX GET', tryGtxGet],
  ['BatchExecute', tryBatchExecute],
];

// The method that worked last time goes first: when Google rate-limits some endpoints, every
// request would otherwise pay for the failing ones before reaching the one that works.
let preferred = 0;

export async function proxyTranslate(text: string, targetLang: string, sourceLang = 'auto'): Promise<string> {
  const order = [preferred, ...METHODS.keys()].filter((v, i, a) => a.indexOf(v) === i);
  let lastError: unknown;
  for (const index of order) {
    const [name, method] = METHODS[index];
    try {
      const result = await method(text, sourceLang, targetLang);
      if (result) {
        preferred = index;
        return result;
      }
      throw new Error(`Empty result from ${name}`);
    } catch (err) {
      lastError = err;
      console.warn(`[Proxy] ${name} failed: ${(err as Error)?.message}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Translation failed');
}
