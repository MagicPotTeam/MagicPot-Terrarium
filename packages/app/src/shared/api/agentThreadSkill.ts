export type ProceduralSkillPackage = { id: string; directory: string; enabled: boolean; projectId?: string; /** Undefined preserves explicit Markdown-directory discovery. */ source?: 'directory' | 'manifest' }
export type ProceduralSkillOptions = {
  enabled: boolean
  /** Simple path globs used for suggestions only, never filesystem authority. */
  paths?: string[]
}
export type ThreadProceduralSkill = {
  id: string
  name: string
  description: string
  instructions: string
  baseDirectory: string
  paths: string[]
  digest: string
  source?: 'markdown'
  disableModelInvocation?: boolean
  metadataFields?: string[]
}
export const THREAD_SKILL_LIMITS = { files: 100, entries: 512, fileBytes: 65536, totalBytes: 1048576, bodyCharacters: 24000, argumentsCharacters: 4000, patterns: 16 } as const
export function isThreadSkillPattern(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.startsWith('/') && !value.includes('\\') && !value.includes(':') && !value.split('/').includes('..') && /^[\p{L}\p{N}_.\- /*?]+$/u.test(value)
}
/** Bounded dynamic-programming glob, no regex engine or brace expansion. */
export type SkillMatchBudget = { remaining: number }
function segmentMatch(pattern: string, value: string, budget: SkillMatchBudget): boolean {
  budget.remaining -= pattern.length * (value.length + 1)
  if (budget.remaining < 0) throw new Error('Procedural skill path matching budget exhausted.')
  const characters = Array.from(value)
  let previous = new Array<boolean>(characters.length + 1).fill(false); previous[0] = true
  for (const token of pattern) {
    const next = new Array<boolean>(characters.length + 1).fill(false)
    if (token === '*') next[0] = previous[0]
    for (let i = 1; i <= characters.length; i++) next[i] = token === '*' ? previous[i] || next[i - 1] : previous[i - 1] && (token === '?' || token === characters[i - 1])
    previous = next
  }
  return previous[characters.length]
}
export function matchesThreadSkillPath(pattern: string, candidate: string, budget: SkillMatchBudget = { remaining: 200000 }): boolean {
  if (!isThreadSkillPattern(pattern) || typeof candidate !== 'string' || !candidate || candidate.length > 512 || candidate.startsWith('/') || candidate.includes('\\') || candidate.includes(':') || candidate.split('/').includes('..')) return false
  const path = candidate.split('/').filter(Boolean)
  if (!pattern.includes('/')) return segmentMatch(pattern, path.at(-1) ?? '', budget)
  const parts = pattern.split('/').filter(Boolean)
  budget.remaining -= parts.length * (path.length + 1)
  if (budget.remaining < 0) throw new Error('Procedural skill path matching budget exhausted.')
  let previous = new Array<boolean>(path.length + 1).fill(false); previous[0] = true
  for (const part of parts) {
    const next = new Array<boolean>(path.length + 1).fill(false)
    if (part === '**') next[0] = previous[0]
    for (let i = 1; i <= path.length; i++) next[i] = part === '**' ? previous[i] || next[i - 1] : previous[i - 1] && segmentMatch(part, path[i - 1], budget)
    previous = next
  }
  return previous[path.length]
}
