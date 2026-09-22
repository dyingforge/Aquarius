/**
 * FTS5 text preparation.
 *
 * The default `unicode61` tokenizer treats a whole run of CJK characters as a
 * single token, which makes Chinese queries unreliable. Both indexed text and
 * query text therefore go through the same augmentation: CJK runs are expanded
 * into overlapping bigrams (plus the full run), while Latin words are indexed
 * as-is. Matching stays a pure FTS5 operation — no embeddings, no vector store.
 */

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN_WORD = /[\p{Letter}\p{Number}][\p{Letter}\p{Number}'’_-]*/gu;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have',
  'how', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'not', 'of', 'on', 'or', 'our', 'should', 'so', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

function isCjk(char: string): boolean {
  return CJK_PATTERN.test(char);
}

/** Splits text into alternating CJK runs and Latin words. */
export function tokenizeForFts(text: string): { cjk: string[]; words: string[] } {
  const cjk: string[] = [];
  const words: string[] = [];
  let run = '';
  const flushRun = (): void => {
    if (run !== '') {
      cjk.push(run);
      run = '';
    }
  };
  for (const char of text) {
    if (isCjk(char)) {
      run += char;
    } else {
      flushRun();
    }
  }
  flushRun();

  for (const match of text.matchAll(LATIN_WORD)) {
    const word = match[0].toLowerCase();
    if (word !== '') words.push(word);
  }
  return { cjk, words };
}

/** Text to store in the FTS columns: the original text plus CJK bigrams. */
export function augmentForIndex(text: string): string {
  const { cjk } = tokenizeForFts(text);
  if (cjk.length === 0) return text;
  const extra: string[] = [];
  for (const run of cjk) {
    extra.push(run);
    if (run.length === 1) continue;
    for (let i = 0; i + 1 < run.length; i += 1) extra.push(run.slice(i, i + 2));
    if (run.length > 2) {
      for (let i = 0; i + 2 < run.length; i += 1) extra.push(run.slice(i, i + 3));
    }
  }
  return `${text} ${extra.join(' ')}`;
}

function quote(term: string): string {
  return `"${term.replace(/"/g, '')}"`;
}

/**
 * Builds a safe FTS5 MATCH expression. Every term is quoted, so user text can
 * never inject FTS operators. Returns null when the query has no usable term.
 */
export function buildMatchQuery(question: string, options: { maxTerms?: number } = {}): string | null {
  const { cjk, words } = tokenizeForFts(question);
  const terms: string[] = [];

  for (const run of cjk) {
    if (run.length === 1) {
      terms.push(quote(run));
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) terms.push(quote(run.slice(i, i + 2)));
  }

  const seenWords = new Set<string>();
  for (const word of words) {
    if (word.length < 2) continue;
    if (STOP_WORDS.has(word)) continue;
    if (seenWords.has(word)) continue;
    seenWords.add(word);
    terms.push(quote(word));
  }

  const unique = [...new Set(terms)].slice(0, options.maxTerms ?? 48);
  if (unique.length === 0) return null;
  return unique.join(' OR ');
}

/**
 * Token set used for lexical comparison: Latin words plus CJK bigrams. Using the
 * same granularity as the index means relevance ranking, correction targeting and
 * consolidation matching all behave consistently for Chinese and English text.
 */
export function lexicalTokens(text: string): Set<string> {
  const { words, cjk } = tokenizeForFts(text);
  const tokens = new Set<string>();
  for (const word of words) {
    if (word.length >= 2) tokens.add(word);
  }
  for (const run of cjk) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    if (run.length <= 3) tokens.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

/** Cheap lexical score used to rank candidates when no model is involved. */
export function lexicalOverlap(query: string, text: string): number {
  const queryTokens = lexicalTokens(query);
  if (queryTokens.size === 0) return 0;
  const targetTokens = lexicalTokens(text);
  let hits = 0;
  for (const token of queryTokens) {
    if (targetTokens.has(token)) hits += 1;
  }
  return hits / queryTokens.size;
}
