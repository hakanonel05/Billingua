import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseRankTable, lemmaCandidates, levelOf, analyzeCEFR, findProperNouns,
  getComprehensionPercentage, wordsToLearn, frequentNames,
} from './cefr';

const table = parseRankTable(fs.readFileSync(path.join(__dirname, '../data/en-freq.txt'), 'utf-8'));

describe('rank table', () => {
  it('skips comments and ranks by line order', () => {
    const t = parseRankTable('# header\nthe\nof\n\nand\n');
    expect([t.get('the'), t.get('of'), t.get('and')]).toEqual([1, 2, 3]);
  });

  it('ships 10,000 words', () => {
    expect(table.size).toBe(10000);
  });
});

describe('lemmaCandidates', () => {
  it('covers common inflections', () => {
    expect(lemmaCandidates('stories')).toContain('story');
    expect(lemmaCandidates('making')).toContain('make');
    expect(lemmaCandidates('stopped')).toContain('stop');
    expect(lemmaCandidates('running')).toContain('run');
    expect(lemmaCandidates('happiest')).toContain('happy');
  });

  it('maps British spellings to American ones', () => {
    expect(lemmaCandidates('behaviour')).toContain('behavior');
    expect(lemmaCandidates('realised')).toContain('realize');
    expect(lemmaCandidates('apologised')).toContain('apologize');
    expect(lemmaCandidates('centre')).toContain('center');
    expect(levelOf('colour', table)).toBe(levelOf('color', table));
  });
});

describe('levelOf', () => {
  it('rates common words low and rare words high', () => {
    expect(levelOf('house', table)).toBe('A1');
    expect(levelOf('houses', table)).toBe('A1');
    expect(levelOf('ubiquitous', table)).toBe('C2');
  });

  it('does not strip -er from listed words', () => {
    // "hunger" must not borrow the rank of "hung"
    expect(levelOf('hunger', new Map([['hunger', 9000], ['hung', 100]]))).toBe('C1');
  });
});

describe('proper nouns', () => {
  const text = 'Ishmael went to sea. The sea was calm. Ishmael smiled. Then Ishmael slept. Queequeg woke.';

  it('treats capitalized words that never appear lowercase as names', () => {
    const names = findProperNouns(text, table);
    expect(names.get('Ishmael')).toBe(3);
    // "The"/"Then" only occur capitalized here, but they are far too common to be names
    expect(names.has('The')).toBe(false);
    expect(names.has('Then')).toBe(false);
  });

  it('ignores contractions, possessives and all-caps headings', () => {
    const names = findProperNouns("CHAPTER THIRTEEN. Emma's TARDIS hummed. I'm here, said Emma. I'll go.", table);
    expect(Array.from(names.keys()).sort()).toEqual(['Emma', 'TARDIS']);
  });

  it('keeps only recurring, uncommon names for the translator', () => {
    expect(frequentNames(text, table)).toEqual(['Ishmael']);
  });
});

describe('analyzeCEFR on real-world text', () => {
  it('skips contractions (straight or typographic apostrophes) and all-caps names', () => {
    const stats = analyzeCEFR('The TARDIS landed. I didn’t know. She couldn\'t see the TARDIS.', table);
    const words = stats.words.map(w => w.word);
    expect(words).not.toContain('tardis');
    expect(words.some(w => w.includes("'") || w === 'didn' || w === 't')).toBe(false);
    expect(stats.total).toBe(7); // the, landed, i, know, she, see, the
  });
});

describe('analyzeCEFR', () => {
  const text = 'The cat sat on the mat. The ubiquitous cat was happy. Ishmael Ishmael Ishmael.';
  const stats = analyzeCEFR(text, table);

  it('excludes names from the counts', () => {
    expect(stats.words.some(w => w.word === 'ishmael')).toBe(false);
  });

  it('counts every running word in exactly one level', () => {
    const sum = stats.A1 + stats.A2 + stats.B1 + stats.B2 + stats.C1 + stats.C2;
    expect(sum).toBe(stats.total);
  });

  it('reports real coverage without a bonus', () => {
    const pct = getComprehensionPercentage(stats, 'C1');
    expect(pct).toBe(Math.round(((stats.total - stats.C2) / stats.total) * 100));
    expect(getComprehensionPercentage(stats, 'C2')).toBe(100);
  });

  it('suggests words above the reader level', () => {
    expect(wordsToLearn(stats, 'B2').map(w => w.word)).toContain('ubiquitous');
    expect(wordsToLearn(stats, 'C2')).toEqual([]);
  });
});
