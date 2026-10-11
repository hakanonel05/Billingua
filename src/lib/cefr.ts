// Frequency-based CEFR estimation.
// A word's level comes from its rank in an English frequency list (src/data/en-freq.txt),
// mapped to the vocabulary sizes commonly associated with each CEFR level. Inflected forms
// are reduced to candidate lemmas so "remarked" is rated like "remark".

export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export type CEFRLevel = typeof CEFR_LEVELS[number];

// Upper rank bound (inclusive) for each level; anything rarer (or not in the list) is C2.
const RANK_LIMITS: [CEFRLevel, number][] = [
  ['A1', 700],
  ['A2', 1500],
  ['B1', 3000],
  ['B2', 5000],
  ['C1', 10000],
];

// Share of running words a reader should know to follow a text comfortably.
const COMFORTABLE_COVERAGE = 0.95;

export interface WordInfo {
  word: string;
  count: number;
  level: CEFRLevel;
}

export interface CEFRLevelStats {
  A1: number;
  A2: number;
  B1: number;
  B2: number;
  C1: number;
  C2: number;
  total: number;
  unique: number;
  estimatedLevel: CEFRLevel;
  // Most frequent words, hardest-first within equal counts; filter by level in the UI.
  words: WordInfo[];
}

export type RankTable = Map<string, number>;

let rankTablePromise: Promise<RankTable> | null = null;

export function parseRankTable(raw: string): RankTable {
  const table: RankTable = new Map();
  let rank = 0;
  for (const line of raw.split('\n')) {
    const word = line.trim();
    if (!word || word.startsWith('#')) continue;
    rank++;
    if (!table.has(word)) table.set(word, rank);
  }
  return table;
}

export function loadRankTable(): Promise<RankTable> {
  if (!rankTablePromise) {
    rankTablePromise = import('../data/en-freq.txt?raw').then(m => parseRankTable(m.default));
  }
  return rankTablePromise;
}

// The frequency list is mostly American English; British spellings borrow the American rank.
export const americanSpelling = (word: string) => word
  .replace(/our(s|ed|ing|able)?$/, 'or$1')
  .replace(/(?<=[a-z]{2})is(e|es|ed|ing|ation|ations)$/, 'iz$1')
  .replace(/yse(s|d)?$/, 'yze$1')
  .replace(/([^aeiou])tre(s)?$/, '$1ter$2');

// Candidate base forms for a lowercase English word, the word itself first.
export function lemmaCandidates(word: string): string[] {
  const out = [word];
  const add = (w: string) => { if (w.length >= 2 && !out.includes(w)) out.push(w); };
  const undouble = (stem: string) => {
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2] && !/[aeiou]/.test(stem[stem.length - 1])) {
      add(stem.slice(0, -1));
    }
  };

  const american = americanSpelling(word);
  add(american);
  for (const form of new Set([word, american])) inflections(form);
  return out;

  function inflections(word: string) {
    if (word.endsWith("'s")) add(word.slice(0, -2));
    if (word.endsWith('ies') && word.length > 4) add(word.slice(0, -3) + 'y');
    if (word.endsWith('es') && word.length > 3) add(word.slice(0, -2));
    if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) add(word.slice(0, -1));
    if (word.endsWith('ied') && word.length > 4) add(word.slice(0, -3) + 'y');
    if (word.endsWith('ed') && word.length > 4) {
      const stem = word.slice(0, -2);
      add(stem); add(stem + 'e'); undouble(stem);
    }
    if (word.endsWith('ing') && word.length > 5) {
      const stem = word.slice(0, -3);
      add(stem); add(stem + 'e'); undouble(stem);
    }
    if (word.endsWith('est') && word.length > 5) {
      const stem = word.slice(0, -3);
      add(stem); add(stem + 'e'); undouble(stem);
      if (stem.endsWith('i')) add(stem.slice(0, -1) + 'y');
    }
    if (word.endsWith('er') && word.length > 4) {
      const stem = word.slice(0, -2);
      add(stem); add(stem + 'e'); undouble(stem);
      if (stem.endsWith('i')) add(stem.slice(0, -1) + 'y');
    }
  }
}

export function rankOf(word: string, table: RankTable): number | undefined {
  // "-er"/"-est" stripping misfires on real words (hunger → hung, corner → corn),
  // so a listed word ending that way keeps its own rank.
  const own = table.get(word);
  if (own !== undefined && /(?:er|est)$/.test(word)) return own;
  let best: number | undefined;
  for (const candidate of lemmaCandidates(word)) {
    const r = table.get(candidate);
    if (r !== undefined && (best === undefined || r < best)) best = r;
  }
  return best;
}

export function levelOf(word: string, table: RankTable): CEFRLevel {
  const rank = rankOf(word.toLowerCase(), table);
  if (rank === undefined) return 'C2';
  for (const [level, limit] of RANK_LIMITS) {
    if (rank <= limit) return level;
  }
  return 'C2';
}

export const levelIndex = (level: string) => CEFR_LEVELS.indexOf(level as CEFRLevel);

const WORD_RE = /[A-Za-z]+(?:'[A-Za-z]+)?/g;

// Sentence-initial function words ("The", "However") are capitalized too, so the most common
// words never count as names even when the text has no lowercase occurrence.
const NEVER_A_NAME_RANK = 300;

// Capitalized words whose lowercase form never occurs in the text: character and place names.
export function findProperNouns(text: string, table?: RankTable): Map<string, number> {
  const capitalized = new Map<string, number>();
  const lowercase = new Set<string>();
  for (const m of text.matchAll(WORD_RE)) {
    const w = m[0];
    if (/^[A-Z][a-z]/.test(w)) capitalized.set(w, (capitalized.get(w) || 0) + 1);
    else if (/^[a-z]/.test(w)) lowercase.add(w);
  }
  const names = new Map<string, number>();
  capitalized.forEach((count, w) => {
    const lower = w.toLowerCase();
    if (lowercase.has(lower)) return;
    if (table && (table.get(lower) ?? Infinity) <= NEVER_A_NAME_RANK) return;
    names.set(w, count);
  });
  return names;
}

// Names worth telling a translator to keep as-is: recurring and not ordinary words.
export function frequentNames(text: string, table: RankTable, limit = 40): string[] {
  return Array.from(findProperNouns(text, table).entries())
    .filter(([w, count]) => count >= 3 && levelIndex(levelOf(w, table)) >= levelIndex('B1'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

export function analyzeCEFR(text: string, table: RankTable): CEFRLevelStats {
  const stats: CEFRLevelStats = {
    A1: 0, A2: 0, B1: 0, B2: 0, C1: 0, C2: 0, total: 0, unique: 0,
    estimatedLevel: 'A1',
    words: [],
  };

  const names = findProperNouns(text, table);
  const counts = new Map<string, number>();
  for (const m of text.matchAll(WORD_RE)) {
    if (names.has(m[0])) continue;
    const word = m[0].toLowerCase().replace(/'s$/, '');
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  const words: WordInfo[] = [];
  counts.forEach((count, word) => {
    const level = levelOf(word, table);
    stats[level] += count;
    stats.total += count;
    words.push({ word, count, level });
  });
  stats.unique = counts.size;

  stats.estimatedLevel = 'C2';
  let covered = 0;
  for (const level of CEFR_LEVELS) {
    covered += stats[level];
    if (stats.total > 0 && covered / stats.total >= COMFORTABLE_COVERAGE) {
      stats.estimatedLevel = level;
      break;
    }
  }

  stats.words = words
    .filter(w => w.word.length >= 3)
    .sort((a, b) => b.count - a.count || levelIndex(b.level) - levelIndex(a.level))
    .slice(0, 2000);

  return stats;
}

// Share of running words at or below the reader's level.
export function getComprehensionPercentage(stats: CEFRLevelStats, userLevel: string): number {
  if (stats.total === 0) return 0;
  const userIdx = levelIndex(userLevel);
  if (userIdx === -1) return 0;
  let known = 0;
  for (let i = 0; i <= userIdx; i++) known += stats[CEFR_LEVELS[i]];
  return Math.round((known / stats.total) * 100);
}

// The most frequent words above the reader's level.
export function wordsToLearn(stats: CEFRLevelStats, userLevel: string, limit = 25): WordInfo[] {
  const userIdx = levelIndex(userLevel);
  return stats.words.filter(w => levelIndex(w.level) > userIdx).slice(0, limit);
}
