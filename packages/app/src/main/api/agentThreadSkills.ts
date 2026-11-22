import { buildSkillContext, type SkillWorkspacePaths } from '../customSkill/context'
import { matchesThreadSkillPath, THREAD_SKILL_LIMITS as LIMITS, type ThreadProceduralSkill } from '@shared/api/agentThreadSkill'

export type ThreadSkillCatalog = { skills: ThreadProceduralSkill[]; truncated: boolean }
export type ThreadSkillInfoInput = { name?: string; paths?: string[]; offset?: number }
export type AgentThreadSkills = ReturnType<typeof createAgentThreadSkills>
let activeReads = 0

/** Instructions are data, never a replacement skillRuntime or an authorization. */
export function createAgentThreadSkills(options: {
  signal: AbortSignal
  assertLive(): void
  load(signal: AbortSignal): Promise<ThreadSkillCatalog>
}) {
  let attempts = 0, busy = false
  let initial: Map<string, string> | undefined
  const read = async <T>(signal: AbortSignal | undefined, consume: (catalog: ThreadSkillCatalog, signal: AbortSignal) => T | Promise<T>): Promise<T> => {
    const combined = AbortSignal.any([options.signal, AbortSignal.timeout(10000), ...(signal ? [signal] : [])])
    const live = () => { combined.throwIfAborted(); options.assertLive() }
    live()
    if (++attempts > 16) throw new Error('Procedural skill request budget exhausted.')
    if (busy || activeReads >= 4) throw new Error('Procedural skill discovery concurrency limit reached.')
    busy = true; activeReads++
    const operation = (async () => {
    try {
      const catalog = await options.load(combined)
      live()
      // Pin the first explicit discovery or independently opted-in metadata snapshot.
      initial ??= new Map(catalog.skills.map((skill) => [skill.id, skill.digest]))
      const skills = catalog.skills.filter((skill) => initial!.get(skill.id) === skill.digest)
      const result = await consume({ skills, truncated: catalog.truncated || skills.length !== catalog.skills.length }, combined)
      live(); return result
    } catch (error) {
      live()
      if (error instanceof Error && error.message.startsWith('Procedural skill')) throw error
      throw new Error('Procedural skill catalog is unavailable. Check the local skill configuration.')
    } finally { busy = false; activeReads-- }
    })()
    // Filesystem promises cannot necessarily be cancelled. Settle the caller on
    // abort, but keep the read slot quarantined until the underlying I/O settles.
    // Both outcomes are observed, including a rejection after the caller leaves.
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => combined.removeEventListener('abort', abort)
      const abort = () => { cleanup(); reject(combined.reason) }
      combined.addEventListener('abort', abort, { once: true })
      if (combined.aborted) abort()
      operation.then((value) => { cleanup(); resolve(value) }, (error) => { cleanup(); reject(error) })
    })
  }
  const select = (skills: ThreadProceduralSkill[], name: string): ThreadProceduralSkill => {
    const matches = skills.filter((skill) => skill.id === name || skill.name === name)
    if (matches.length !== 1) throw new Error('Procedural skill is unavailable, changed, disabled or ambiguous. Start a new request after editing skills.')
    return matches[0]
  }
  const detail = (skill: ThreadProceduralSkill) => ({
    id: skill.id, name: skill.name, description: skill.description, instructions: skill.instructions,
    baseDirectory: skill.baseDirectory, paths: skill.paths,
    relativePathPolicy: 'Resolve bundled relative references/scripts/assets against baseDirectory; keep explicitly project-relative paths relative to the project. Use separately authorized file/tools and absolute paths for bundled resources; no resource is loaded by this operation.',
    ...(skill.source ? { source: skill.source, disableModelInvocation: skill.disableModelInvocation === true, ignoredMetadataFields: skill.metadataFields ?? [] } : {}),
    resourcePolicy: 'Base directory is reference context only, not file access permission. No resources, attachments or scripts have been loaded or executed; use separately authorized tools for any later operation.',
    untrustedData: true, grantsPermission: false, mode: 'instructions-only'
  })
  let contextSnapshot: Promise<string> | undefined, contextSettings: string | undefined, assertContextSnapshot: (() => void) | undefined
  return {
    context: async (settings: { index: boolean; paths: boolean; scan?(signal: AbortSignal): Promise<SkillWorkspacePaths>; assertCurrent(): void }, signal?: AbortSignal): Promise<string> => {
      assertContextSnapshot?.()
      settings.assertCurrent()
      const signature = JSON.stringify([settings.index, settings.paths])
      if (contextSettings !== undefined && contextSettings !== signature) throw new Error('Procedural skill context changed; start a new request.')
      if (!settings.index && !settings.paths) return Promise.resolve('')
      contextSettings ??= signature; assertContextSnapshot ??= settings.assertCurrent
      options.assertLive(); signal?.throwIfAborted()
      contextSnapshot ??= read(signal, async (catalog, ownedSignal) => {
        settings.assertCurrent()
        let scan: SkillWorkspacePaths | undefined
        if (settings.paths) {
          try { scan = await settings.scan?.(ownedSignal) ?? { paths: [], truncated: false, unavailable: true } }
          catch { ownedSignal.throwIfAborted(); settings.assertCurrent(); scan = { paths: [], truncated: false, unavailable: true } }
        }
        settings.assertCurrent()
        return buildSkillContext(catalog.skills, { index: settings.index, paths: settings.paths, catalogTruncated: catalog.truncated, scan })
      })
      return contextSnapshot
    },
    metadata: (signal?: AbortSignal) => read(signal, catalog => ({ skills: catalog.skills.map(skill => ({ id: skill.id, name: skill.name, description: skill.description.slice(0, 500), paths: [...skill.paths], hidden: skill.disableModelInvocation === true })), truncated: catalog.truncated })),
    describe: (input: ThreadSkillInfoInput, signal?: AbortSignal) => read(signal, (catalog) => {
      if (input.name) {
        if (input.paths !== undefined || input.offset !== undefined) throw new Error('Procedural skill detail does not accept paths or offset.')
        return detail(select(catalog.skills, input.name))
      }
      const paths = input.paths ?? [], budget = { remaining: 2000000 }
      const discoverable = catalog.skills.filter(skill => !skill.disableModelInvocation)
      const skills = paths.length ? discoverable.filter((skill) => !skill.paths.length || skill.paths.some((pattern) => paths.some((candidate) => matchesThreadSkillPath(pattern, candidate, budget)))) : discoverable
      const offset = input.offset ?? 0, page = skills.slice(offset, offset + 20)
      return { skills: page.map(({ id, name, description, paths }) => ({ id, name, description, paths })), nextOffset: skills.length > offset + 20 ? offset + 20 : null, truncated: catalog.truncated, pathSource: 'caller-supplied-relative-paths; existence not verified', untrustedData: true, grantsPermission: false }
    }),
    invoke: (name: string, argumentsText: string, signal?: AbortSignal) => {
      if (!name.trim() || name.length > 128 || argumentsText.length > LIMITS.argumentsCharacters) throw new Error('Procedural skill arguments exceed limits.')
      return read(signal, (catalog) => ({ ...detail(select(catalog.skills, name)), arguments: argumentsText, executed: false }))
    }
  }
}
