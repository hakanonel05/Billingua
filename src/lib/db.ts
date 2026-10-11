import { get, set, del, keys, getMany, setMany, clear, createStore, UseStore } from 'idb-keyval';
import type { AppConfig } from '../types';

export interface SavedBook {
  id: string;
  title: string;
  date: number;
  blob: Blob;
  sourceLang: string;
  targetLang: string;
  coverUrl?: string;
}

export async function saveBookToLibrary(book: SavedBook) {
  await set(`book_${book.id}`, book);
}

export async function getLibraryBooks(): Promise<SavedBook[]> {
  const allKeys = await keys();
  const bookKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith('book_'));
  const books = await Promise.all(bookKeys.map(k => get(k as string)));
  return books.sort((a, b) => b.date - a.date);
}

export async function deleteBookFromLibrary(id: string) {
  await del(`book_${id}`);
}

// --- Translation cache ---
// Kept in its own database so thousands of entries never slow down the library listing.
// Every call degrades to a no-op where IndexedDB is unavailable (private mode, tests).

let cacheStore: UseStore | null | undefined;
const getCacheStore = (): UseStore | null => {
  if (cacheStore === undefined) {
    cacheStore = typeof indexedDB === 'undefined' ? null : createStore('billingua-cache', 'translations');
  }
  return cacheStore;
};

export async function getCachedTranslations(cacheKeys: string[]): Promise<(string | undefined)[]> {
  const store = getCacheStore();
  if (!store || cacheKeys.length === 0) return cacheKeys.map(() => undefined);
  try {
    return await getMany<string>(cacheKeys, store);
  } catch {
    return cacheKeys.map(() => undefined);
  }
}

export async function setCachedTranslations(entries: [string, string][]) {
  const store = getCacheStore();
  if (!store || entries.length === 0) return;
  try {
    await setMany(entries, store);
  } catch (e) {
    console.warn('Translation cache write failed', e);
  }
}

export async function clearTranslationCache() {
  const store = getCacheStore();
  if (store) await clear(store);
}

// --- Settings ---

const SETTINGS_KEY = 'billingua:settings';

export interface StoredSettings {
  config: Partial<AppConfig>;
  isDarkMode: boolean;
  userLevel: string;
}

export function loadSettings(): Partial<StoredSettings> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveSettings(settings: StoredSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: settings simply won't survive a reload.
  }
}

// --- Unfinished job ---
// The source EPUB and chapter selection of a translation that hasn't finished yet. Together
// with the translation cache this lets a reload resume without paying for finished paragraphs.

const JOB_KEY = 'job_current';

export interface PendingJob {
  fileName: string;
  file: Blob;
  selectedChapterIds: string[];
  startedAt: number;
}

export async function savePendingJob(job: PendingJob) {
  try {
    await set(JOB_KEY, job);
  } catch (e) {
    console.warn('Could not save pending job', e);
  }
}

export async function loadPendingJob(): Promise<PendingJob | undefined> {
  try {
    return await get<PendingJob>(JOB_KEY);
  } catch {
    return undefined;
  }
}

export async function clearPendingJob() {
  try {
    await del(JOB_KEY);
  } catch {
    // Nothing to clean up.
  }
}
