// Desktop app (Windows .exe). Serves the built web app from a private app:// origin and answers
// /api/process-text itself, so no local web server or open port is needed. The origin never
// changes between launches, which keeps the library, settings and translation cache.
import { app, BrowserWindow, protocol, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { proxyTranslate } from '../server/translate-proxy';

const SCHEME = 'app';
const ORIGIN = `${SCHEME}://billingua`;

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const distDir = () => path.join(app.getAppPath(), 'dist');

async function handleApi(request: Request, pathname: string): Promise<Response> {
  if (pathname === '/api/health') return Response.json({ status: 'ok' });
  if (pathname === '/api/process-text' && request.method === 'POST') {
    const { text, targetLang, sourceLang = 'auto' } = await request.json();
    if (!text || !targetLang) return Response.json({ error: 'Missing text or targetLang' }, { status: 400 });
    try {
      return Response.json({ translation: await proxyTranslate(text, targetLang, sourceLang) });
    } catch (err) {
      return Response.json({ error: 'Translation failed after multiple attempts.', details: (err as Error)?.message }, { status: 500 });
    }
  }
  return Response.json({ error: 'Not found' }, { status: 404 });
}

async function handleRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/api/')) return handleApi(request, pathname);

  const root = distDir();
  let file = path.normalize(path.join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root)) return new Response('Forbidden', { status: 403 });
  // Unknown paths fall back to the single-page app.
  const stat = await fs.stat(file).catch(() => null);
  if (!stat || stat.isDirectory()) file = path.join(root, 'index.html');
  const body = await fs.readFile(file);
  return new Response(body, { headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Billingua',
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    icon: path.join(distDir(), 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  // Links to the web (API key pages, docs) open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(ORIGIN)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  win.loadURL(`${ORIGIN}/`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    protocol.handle(SCHEME, handleRequest);
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
