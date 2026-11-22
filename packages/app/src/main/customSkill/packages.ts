/* eslint-disable no-control-regex -- Reject control bytes in configured local directory paths. */
import fs from 'node:fs/promises'
import { constants, type Stats } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { THREAD_SKILL_LIMITS as LIMITS, type ProceduralSkillPackage, type ThreadProceduralSkill } from '@shared/api/agentThreadSkill'
import { parseSkillMarkdown } from './markdown'
import { parseSkillPackageManifest } from './packageManifest'

const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const unchanged = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino
const sameFile = (a: Stats, b: Stats) => unchanged(a, b) && b.isFile() && !b.isSymbolicLink() && b.nlink === 1 && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
const safeId = (value: unknown, max = 64): value is string => typeof value === 'string' && new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,${max - 1}}$`).test(value)
const optionalStat = (file: string) => fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
/** Validate settings without reading a path. Package text can never opt itself in. */
export function validateSkillPackages(value: unknown): asserts value is ProceduralSkillPackage[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Procedural skill package registry exceeds limits.')
  const ids = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['id', 'directory', 'enabled', 'projectId', 'source'].includes(key)) || !safeId(item.id) || ids.has(item.id) || typeof item.enabled !== 'boolean' || typeof item.directory !== 'string' || item.directory.length > 1024 || /[\u0000-\u001f\u007f]/.test(item.directory) || item.projectId !== undefined && item.projectId !== '' && !safeId(item.projectId, 128) || item.source !== undefined && !['directory', 'manifest'].includes(item.source)) throw new Error('Procedural skill package registry is invalid.')
    if (item.enabled && (!path.isAbsolute(item.directory) || /^[\\/]{2}/.test(item.directory) || process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(item.directory))) throw new Error('Procedural skill package directory must be an absolute local path.')
    ids.add(item.id)
  }
}
async function fenceDirectory(directory: string, signal?: AbortSignal) {
  const absolute = path.resolve(directory), held: Array<{ file: string; stat: Stats }> = []
  let current = path.parse(absolute).root
  for (const part of ['', ...absolute.slice(current.length).split(path.sep).filter(Boolean)]) {
    signal?.throwIfAborted()
    if (part) current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(current), current)) throw new Error('Procedural skill package requires ordinary canonical directories.')
    held.push({ file: current, stat })
  }
  return async () => {
    for (const item of held) {
      signal?.throwIfAborted(); const stat = await fs.lstat(item.file)
      if (!stat.isDirectory() || stat.isSymbolicLink() || !unchanged(item.stat, stat) || !samePath(await fs.realpath(item.file), item.file)) throw new Error('Procedural skill package directory changed during read.')
    }
  }
}
type Candidate = { file: string; fallback: string; folder: boolean; description?: string }
/** Bounded optimistic identity fences, not an atomic openat/OS directory sandbox.
 * Locally writable contents remain untrusted and are pinned by request digest.
 * Never creates/copies/executes package files or grants their tool metadata. */
export async function loadRegisteredSkillPackages(value: unknown, projectId: string, signal?: AbortSignal): Promise<{ skills: ThreadProceduralSkill[]; truncated: boolean }> {
  validateSkillPackages(value)
  const registry = structuredClone(value), skills: ThreadProceduralSkill[] = []
  let entries = 0, files = 0, bytes = 0, truncated = false
  for (const registration of registry) {
    signal?.throwIfAborted()
    if (!registration.enabled || registration.projectId && registration.projectId !== projectId) continue
    try {
      const root = path.resolve(registration.directory), checkRoot = await fenceDirectory(root, signal)
      const readFile = async (file: string) => {
        signal?.throwIfAborted(); await checkRoot()
        const checkParent = await fenceDirectory(path.dirname(file), signal), before = await fs.lstat(file)
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > LIMITS.fileBytes || before.size + bytes > LIMITS.totalBytes || !samePath(await fs.realpath(file), file)) throw new Error('Unsafe procedural skill file.')
        const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        try {
          const opened = await handle.stat()
          if (!sameFile(before, opened)) throw new Error('Procedural skill file identity changed.')
          const buffer = Buffer.alloc(Math.min(LIMITS.fileBytes, LIMITS.totalBytes - bytes) + 1)
          let count = 0
          while (count < buffer.length) { signal?.throwIfAborted(); const read = await handle.read(buffer, count, buffer.length - count, count); if (!read.bytesRead) break; count += read.bytesRead }
          bytes += count
          const after = await handle.stat(), current = await fs.lstat(file)
          if (count > LIMITS.fileBytes || bytes > LIMITS.totalBytes || count !== before.size || !sameFile(before, after) || !sameFile(after, current)) throw new Error('Procedural skill file changed or exceeds limits.')
          const check = async () => {
            await checkRoot(); await checkParent(); signal?.throwIfAborted()
            if (!samePath(await fs.realpath(file), file) || !sameFile(after, await fs.lstat(file))) throw new Error('Procedural skill file path changed at read completion.')
          }
          await check()
          const raw = buffer.subarray(0, count)
          return { text: new TextDecoder('utf-8', { fatal: true }).decode(raw), digest: createHash('sha256').update(raw).digest('hex'), check }
        } finally { await handle.close() }
      }
      const candidates: Candidate[] = []
      let manifest: { digest: string; check: () => Promise<void> } | undefined
      if (registration.source === 'manifest') {
        const yaml = path.join(root, 'kohaku.yaml'), yml = path.join(root, 'kohaku.yml')
        const primary = await optionalStat(yaml), selected = primary ? yaml : yml
        const snapshot = await readFile(selected)
        manifest = { digest: snapshot.digest, check: async () => {
          await snapshot.check()
          if (!primary && await optionalStat(yaml)) throw new Error('Procedural skill manifest precedence changed.')
        } }
        for (const declaration of parseSkillPackageManifest(snapshot.text)) {
          signal?.throwIfAborted()
          if (++entries > LIMITS.entries) throw new Error('Procedural skill manifest entry limit exceeded.')
          const candidate = path.join(root, ...declaration.path.split('/'))
          const checkParent = await fenceDirectory(path.dirname(candidate), signal), stat = await optionalStat(candidate)
          let file: string, folder = false
          if (stat?.isSymbolicLink() || stat && !stat.isFile() && !stat.isDirectory()) throw new Error('Unsafe procedural skill manifest target.')
          if (stat?.isFile()) {
            if (!candidate.endsWith('.md')) throw new Error('Procedural skill manifest target must be Markdown.')
            file = candidate
          } else if (stat?.isDirectory() && await optionalStat(path.join(candidate, 'SKILL.md'))) { file = path.join(candidate, 'SKILL.md'); folder = true }
          else {
            const extension = path.extname(candidate)
            file = (extension ? candidate.slice(0, -extension.length) : candidate) + '.md'
            if (!await optionalStat(file)) throw new Error('Procedural skill manifest target is missing.')
          }
          await checkParent(); await manifest.check()
          candidates.push({ file, folder, fallback: declaration.name, description: declaration.description })
        }
      } else {
        const own = await optionalStat(path.join(root, 'SKILL.md'))
        if (own) candidates.push({ file: path.join(root, 'SKILL.md'), fallback: path.basename(root), folder: true })
        else {
          const dir = await fs.opendir(root)
          try {
            for await (const entry of dir) {
              signal?.throwIfAborted()
              if (++entries > LIMITS.entries) { truncated = true; break }
              if (entry.isDirectory() && !entry.name.startsWith('.')) candidates.push({ file: path.join(root, entry.name, 'SKILL.md'), fallback: entry.name, folder: true })
              else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.')) candidates.push({ file: path.join(root, entry.name), fallback: path.basename(entry.name, '.md'), folder: false })
            }
          } finally { await dir.close().catch(() => undefined) }
        }
        candidates.sort((a, b) => Number(b.folder) - Number(a.folder) || a.file.localeCompare(b.file))
      }
      const snapshotChecks: Array<() => Promise<void>> = []
      const folderNames = new Set<string>(), effectiveNames = new Set<string>(), effectiveFiles = new Set<string>(), loaded: ThreadProceduralSkill[] = []
      for (const candidate of candidates) {
        signal?.throwIfAborted()
        if (++files > LIMITS.files || bytes >= LIMITS.totalBytes) {
          truncated = true
          if (manifest) throw new Error('Procedural skill manifest exceeds request read limits.')
          break
        }
        try {
          await manifest?.check()
          const snapshot = await readFile(candidate.file), parsed = parseSkillMarkdown(snapshot.text, candidate.fallback, candidate.description)
          await manifest?.check()
          // Keep historical directory-mode IDs. Manifest aliases use the actual
          // pathname, including directory mode's fixed SKILL.md marker on Windows.
          // Case-only declaration edits must not bypass a stored session denial.
          let identityFile = candidate.file
          if (manifest) {
            identityFile = await fs.realpath(candidate.file)
            if (process.platform === 'win32' && path.basename(identityFile).toLowerCase() === 'skill.md') identityFile = path.join(path.dirname(identityFile), 'SKILL.md')
            await snapshot.check()
            const fileKey = process.platform === 'win32' ? identityFile.toLowerCase() : identityFile
            if (effectiveNames.has(parsed.name) || effectiveFiles.has(fileKey)) throw new Error('Procedural skill manifest targets are ambiguous.')
            effectiveNames.add(parsed.name); effectiveFiles.add(fileKey); snapshotChecks.push(snapshot.check)
          } else {
            if (!candidate.folder && folderNames.has(parsed.name)) continue
            if (candidate.folder) folderNames.add(parsed.name)
          }
          const content = { id: `pkg-${registration.id}-${createHash('sha256').update(path.relative(root, identityFile)).digest('hex').slice(0, 16)}`, ...parsed, baseDirectory: path.dirname(candidate.file), source: 'markdown' as const }
          loaded.push({ ...content, digest: createHash('sha256').update(JSON.stringify([registration, content, ...(manifest ? [manifest.digest] : [])])).digest('hex') })
        } catch (error) {
          signal?.throwIfAborted()
          if (manifest) throw error
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') truncated = true
        }
      }
      await manifest?.check()
      for (const check of snapshotChecks) await check()
      await manifest?.check()
      // A manifest is published as one passive declaration snapshot, never as a partial scan.
      skills.push(...loaded)
      if (entries > LIMITS.entries || files > LIMITS.files || bytes >= LIMITS.totalBytes) break
    } catch { signal?.throwIfAborted(); truncated = true }
  }
  return { skills, truncated }
}
