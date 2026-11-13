export type Bm25DocumentStats = { length: number; frequencies: readonly number[] }
/** Okapi BM25 with k1=1.2, b=0.75, positive Robertson IDF.
 * Corpus statistics must describe the complete explicitly bounded scan window,
 * not merely the first k matching results. No embeddings or FTS engine here. */
export function rankBm25(documents: readonly Bm25DocumentStats[], termCount: number): number[] {
  if (!Number.isInteger(termCount) || termCount < 1 || termCount > 16 || documents.length > 4096 || documents.some(doc => !Number.isSafeInteger(doc.length) || doc.length < 0 || doc.length > 8192 || doc.frequencies.length !== termCount || doc.frequencies.some(tf => !Number.isSafeInteger(tf) || tf < 0 || tf > doc.length) || doc.frequencies.reduce((sum, tf) => sum + tf, 0) > doc.length) || documents.reduce((sum, doc) => sum + doc.length, 0) > 500000) throw new Error('Invalid bounded BM25 statistics.')
  const count = documents.length, average = count ? documents.reduce((sum, doc) => sum + doc.length, 0) / count : 0
  if (!count || !average) return documents.map(() => 0)
  const df = Array.from({ length: termCount }, (_, term) => documents.reduce((sum, doc) => sum + Number(doc.frequencies[term] > 0), 0))
  return documents.map(doc => doc.frequencies.reduce((score, tf, term) => {
    if (!tf) return score
    const idf = Math.log(1 + (count - df[term] + 0.5) / (df[term] + 0.5))
    return score + idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.length / average))
  }, 0))
}
