import { get, set, del, keys } from 'idb-keyval';

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
