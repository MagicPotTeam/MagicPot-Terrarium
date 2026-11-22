import { AGENT_THREAD_MEMORY_LIMITS as LIMITS, type AgentArchiveSearch } from './agentThreadMemory'

export const escapedMemoryLiteral = (query: string): RegExp => new RegExp(Array.from({ length: query.length }, (_, index) => `\\u${query.charCodeAt(index).toString(16).padStart(4, '0')}`).join(''), 'iu')
export function memoryLexicalTerms(query: string): string[] {
  const terms = [...new Set(query.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [])]
  if (!terms.length || terms.length > LIMITS.lexicalTerms) throw new Error('Lexical memory query requires 1–16 Unicode word/number terms; use literal mode for punctuation.')
  return terms
}
export function validateAgentArchiveSearch(search: AgentArchiveSearch): void {
  if (typeof search.query !== 'string' || search.query.length > LIMITS.queryCharacters) throw new Error('Invalid archive search.')
  const query = search.query.trim(), limit = search.limit ?? 5, source = search.source ?? 'messages', mode = search.mode ?? 'literal'
  if (!query || query.length > LIMITS.queryCharacters || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.matches || !['messages', 'tools', 'all'].includes(source) || !['literal', 'lexical', 'bm25'].includes(mode) ||
    (search.beforeMessage !== undefined && (!Number.isSafeInteger(search.beforeMessage) || search.beforeMessage < 0 || search.beforeMessage > 10000000)) ||
    (search.beforeCharacter !== undefined && (!Number.isSafeInteger(search.beforeCharacter) || search.beforeCharacter < 0 || search.beforeMessage === undefined)) ||
    (search.beforeEvent !== undefined && (!Number.isSafeInteger(search.beforeEvent) || search.beforeEvent < 0 || search.beforeEvent > 20000001 || search.beforeMessage === undefined || source === 'messages')) ||
    (source !== 'messages' && search.beforeCharacter !== undefined && search.beforeEvent === undefined) ||
    (search.toolName !== undefined && (source === 'messages' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(search.toolName)))) throw new Error('Invalid archive search.')
  if (mode === 'lexical' || mode === 'bm25') memoryLexicalTerms(query)
}
