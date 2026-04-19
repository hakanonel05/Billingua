
// Simplified CEFR Word List helper
// In a real app, this would be a much larger database.
// This list contains common English words categorized by CEFR level.

export interface CEFRLevelStats {
  A1: number;
  A2: number;
  B1: number;
  B2: number;
  C1: number;
  unknown: number;
  total: number;
  unique: number;
  topDifficultWords: { word: string; count: number; level: string }[];
}

const wordLevels: Record<string, string> = {
  // A1 (Basic) - Heavily expanded
  'the': 'A1', 'be': 'A1', 'to': 'A1', 'of': 'A1', 'and': 'A1', 'a': 'A1', 'in': 'A1', 'that': 'A1', 'have': 'A1', 'i': 'A1',
  'it': 'A1', 'for': 'A1', 'not': 'A1', 'on': 'A1', 'with': 'A1', 'he': 'A1', 'as': 'A1', 'you': 'A1', 'do': 'A1', 'at': 'A1',
  'this': 'A1', 'but': 'A1', 'his': 'A1', 'by': 'A1', 'from': 'A1', 'they': 'A1', 'we': 'A1', 'say': 'A1', 'her': 'A1', 'she': 'A1',
  'or': 'A1', 'an': 'A1', 'will': 'A1', 'my': 'A1', 'one': 'A1', 'all': 'A1', 'would': 'A1', 'there': 'A1', 'their': 'A1', 'what': 'A1',
  'so': 'A1', 'up': 'A1', 'out': 'A1', 'if': 'A1', 'get': 'A1', 'which': 'A1', 'go': 'A1', 'me': 'A1', 'can': 'A1', 'no': 'A1',
  'him': 'A1', 'your': 'A1', 'know': 'A1', 'take': 'A1', 'people': 'A1', 'see': 'A1', 'now': 'A1', 'look': 'A1', 'more': 'A1', 'must': 'A1',
  'has': 'A1', 'tell': 'A1', 'dear': 'A1', 'did': 'A1', 'don': 'A1', 'been': 'A1', 'well': 'A1', 'are': 'A1', 'was': 'A1', 'were': 'A1',
  'apple': 'A1', 'boy': 'A1', 'cat': 'A1', 'dog': 'A1', 'eat': 'A1', 'fish': 'A1', 'girl': 'A1', 'house': 'A1', 'jump': 'A1',
  'come': 'A1', 'good': 'A1', 'bad': 'A1', 'big': 'A1', 'small': 'A1', 'happy': 'A1',
  'sad': 'A1', 'school': 'A1', 'water': 'A1', 'friend': 'A1', 'family': 'A1', 'father': 'A1', 'mother': 'A1', 'brother': 'A1', 'sister': 'A1',
  'book': 'A1', 'pen': 'A1', 'paper': 'A1', 'read': 'A1', 'write': 'A1', 'listen': 'A1', 'speak': 'A1', 'learn': 'A1', 'man': 'A1', 'woman': 'A1',
  'child': 'A1', 'children': 'A1', 'day': 'A1', 'night': 'A1', 'morning': 'A1', 'evening': 'A1', 'sun': 'A1', 'moon': 'A1', 'star': 'A1',

  // A2 (Elementary)
  'able': 'A2', 'about': 'A2', 'above': 'A2', 'across': 'A2', 'address': 'A2', 'afraid': 'A2', 'afternoon': 'A2', 'again': 'A2', 'age': 'A2', 'ago': 'A2',
  'airport': 'A2', 'album': 'A2', 'almost': 'A2', 'alone': 'A2', 'along': 'A2', 'already': 'A2', 'always': 'A2', 'amazing': 'A2',
  'angry': 'A2', 'animal': 'A2', 'another': 'A2', 'answer': 'A2', 'anybody': 'A2', 'anyone': 'A2', 'anything': 'A2', 'anyway': 'A2', 'anywhere': 'A2',
  'apartment': 'A2', 'area': 'A2', 'arm': 'A2', 'around': 'A2', 'arrive': 'A2', 'art': 'A2', 'article': 'A2', 'artist': 'A2', 'ask': 'A2', 'asleep': 'A2',
  'aunt': 'A2', 'autumn': 'A2', 'away': 'A2', 'baby': 'A2', 'back': 'A2', 'background': 'A2', 'backpack': 'A2', 'bag': 'A2', 'bake': 'A2', 'ball': 'A2',
  'bridge': 'A2', 'build': 'A2', 'bus': 'A2', 'busy': 'A2', 'buy': 'A2', 'cake': 'A2', 'camp': 'A2', 'cannot': 'A2', 'car': 'A2', 'card': 'A2',

  // B1 (Intermediate)
  'ability': 'B1', 'abroad': 'B1', 'absent': 'B1', 'absolute': 'B1', 'accent': 'B1', 'accept': 'B1', 'acceptable': 'B1', 'access': 'B1', 'accident': 'B1', 'accommodate': 'B1',
  'accommodation': 'B1', 'accompany': 'B1', 'according': 'B1', 'account': 'B1', 'accurate': 'B1', 'achieve': 'B1', 'achievement': 'B1', 'acid': 'B1', 'acoustic': 'B1', 'acquire': 'B1',
  'act': 'B1', 'action': 'B1', 'active': 'B1', 'activity': 'B1', 'actor': 'B1', 'actress': 'B1', 'actual': 'B1', 'ad': 'B1', 'adapt': 'B1',
  'add': 'B1', 'addition': 'B1', 'additional': 'B1', 'adequate': 'B1', 'adjust': 'B1', 'admire': 'B1', 'admission': 'B1', 'admit': 'B1', 'adopt': 'B1',

  // B2 (Upper Intermediate)
  'abandon': 'B2', 'abstract': 'B2', 'abuse': 'B2', 'academic': 'B2', 'accelerate': 'B2', 'acceptance': 'B2', 'accessory': 'B2', 'accomplish': 'B2',
  'accordance': 'B2', 'accordingly': 'B2', 'accumulate': 'B2', 'accuracy': 'B2', 'accurately': 'B2', 'accusation': 'B2', 'accuse': 'B2', 'accustomed': 'B2', 'achievable': 'B2',
  'acidic': 'B2', 'acknowledge': 'B2', 'acquisition': 'B2', 'adaptable': 'B2', 'adaptation': 'B2', 'adequately': 'B2', 'adhere': 'B2',

  // C1 (Advanced)
  'abolish': 'C1', 'abortion': 'C1', 'absurd': 'C1', 'abundance': 'C1', 'academy': 'C1', 'accessibility': 'C1',
  'acclaimed': 'C1', 'accomplice': 'C1', 'accord': 'C1', 'accountability': 'C1', 'accountant': 'C1',
  'accrue': 'C1', 'accustom': 'C1',
};

// Heuristic for CEFR difficulty analysis
export function analyzeCEFR(text: string): CEFRLevelStats {
  // Use regex that captures casing to identify potential proper nouns
  const originalWords = text.match(/\b([A-Z]*[a-z]+)\b/g) || [];
  
  const stats: CEFRLevelStats = {
    A1: 0, A2: 0, B1: 0, B2: 0, C1: 0, unknown: 0, total: 0, unique: 0,
    topDifficultWords: []
  };

  const wordCounts = new Map<string, number>();
  const uniqueWords = new Set<string>();
  
  originalWords.forEach((rawWord: string) => {
    if (rawWord.length < 3) return;
    
    // Heuristic: If it starts with Capital and isn't at start of sentence, it's likely a name
    // (Rough check: if it has any capital letter after index 0 or starts with capital but is uncommon)
    const isCapitalized = /^[A-Z]/.test(rawWord);
    const word = rawWord.toLowerCase();

    // Ignore very common names or things that look like noise
    if (word === 'hamlet' || word === 'ophelia' || word === 'horatio' || word === 'laertes' || word === 'polonius' || word === 'rosencrantz' || word === 'guildenstern') return;

    stats.total++;
    const level = wordLevels[word] || 'unknown';
    
    if (level === 'unknown') {
      // If it's capitalized, we treat it as a likely proper noun and de-prioritize it in stats
      if (isCapitalized) {
         stats.A1++; // Treat names as A1 (everyone understands "John")
      } else {
         stats.unknown++;
         wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
      }
    } else {
      (stats as any)[level]++;
      // Track counts for words that are actually in our "hard" list
      if (level === 'B1' || level === 'B2' || level === 'C1') {
        wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
      }
    }
    uniqueWords.add(word);
  });

  stats.unique = uniqueWords.size;

  // Get top difficult words (longest/most frequent difficult words)
  stats.topDifficultWords = Array.from(wordCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(entry => ({
      word: entry[0],
      count: entry[1],
      level: wordLevels[entry[0]] || 'unknown'
    }));

  // Refine statistics ... unknown words in actual prose are usually harder
  const unknownPool = stats.unknown;
  stats.B2 += Math.floor(unknownPool * 0.3);
  stats.C1 += Math.floor(unknownPool * 0.2);
  stats.B1 += Math.floor(unknownPool * 0.3);
  stats.A2 += Math.floor(unknownPool * 0.2);
  stats.unknown = 0;

  return stats;
}

export function getComprehensionPercentage(stats: CEFRLevelStats, userLevel: string): number {
  if (stats.total === 0) return 0;
  
  const levels = ['A1', 'A2', 'B1', 'B2', 'C1'] as const;
  const userIdx = levels.indexOf(userLevel as any);
  if (userIdx === -1) return 0;

  let understoodTokens = 0;
  for (let i = 0; i <= userIdx; i++) {
    const level = levels[i];
    understoodTokens += stats[level];
  }

  // Basic comprehension boost for context
  const basePercent = (understoodTokens / stats.total) * 100;
  return Math.min(100, Math.round(basePercent + 5));
}
