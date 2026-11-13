import fs from 'node:fs/promises'
import path from 'node:path'
import { matchesThreadSkillPath, type ThreadProceduralSkill } from '@shared/api/agentThreadSkill'

export type SkillWorkspacePaths = { paths: string[]; truncated: boolean; unavailable?: boolean }
const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
/** Names only in a main-resolved workspace. No cwd fallback, content reads or writes. */
export async function scanSkillWorkspace(directory: string, signal: AbortSignal, assertLive: () => void): Promise<SkillWorkspacePaths> {
  const paths: string[] = []; let entries = 0, truncated = false
  const check = () => { signal.throwIfAborted(); assertLive() }
  check()
  if (!path.isAbsolute(directory) || /^[\\/]{2}/.test(directory)) throw new Error('Procedural skill workspace must be a local absolute directory.')
  const root = path.resolve(directory)
  // Reject linked ancestors as well as the last component. Optimistic checks,
  // not an atomic directory sandbox against a concurrently writable local tree.
  let current = path.parse(root).root
  const ancestors: Array<{ file: string; dev: number; ino: number }> = []
  for (const part of ['', ...root.slice(current.length).split(path.sep).filter(Boolean)]) {
    check(); if (part) current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(await fs.realpath(current), current)) throw new Error('Procedural skill workspace is linked or noncanonical.')
    ancestors.push({ file: current, dev: stat.dev, ino: stat.ino })
  }
  const fence = async () => { for (const item of ancestors) { check(); const stat = await fs.lstat(item.file); if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== item.dev || stat.ino !== item.ino || !same(await fs.realpath(item.file), item.file)) throw new Error('Procedural skill workspace changed during scan.') } }
  const queue = [{ directory: root, depth: 0, dev: ancestors.at(-1)!.dev, ino: ancestors.at(-1)!.ino }], skipped = new Set(['node_modules', 'vendor', 'dist', 'out', 'build', '__pycache__', 'venv'])
  scan: while (queue.length) {
    check(); await fence()
    const item = queue.shift()!, before = await fs.lstat(item.directory)
    if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== item.dev || before.ino !== item.ino || !same(await fs.realpath(item.directory), item.directory)) { truncated = true; continue }
    const dir = await fs.opendir(item.directory)
    try {
      for await (const entry of dir) {
        check()
        if (++entries > 2048 || paths.length >= 500) { truncated = true; break scan }
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        const file = path.join(item.directory, entry.name), relative = path.relative(root, file).split(path.sep).join('/')
        if (!relative || relative.startsWith('../') || relative.length > 512) { truncated = true; continue }
        const stat = await fs.lstat(file)
        if (stat.isSymbolicLink() || !same(await fs.realpath(file), file)) { truncated = true; continue }
        if (stat.isDirectory()) {
          if (skipped.has(entry.name)) continue
          if (item.depth >= 3) { truncated = true; continue }
          queue.push({ directory: file, depth: item.depth + 1, dev: stat.dev, ino: stat.ino })
        } else if (stat.isFile() && stat.nlink === 1) paths.push(relative)
      }
    } finally { await dir.close().catch(() => undefined) }
    const after = await fs.lstat(item.directory)
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new Error('Procedural skill workspace directory changed during scan.')
  }
  await fence(); check()
  return { paths: paths.sort(), truncated }
}

/** Strictly metadata-only output, one byte budget for the entire context block. */
export function buildSkillContext(skills: ThreadProceduralSkill[], options: { index: boolean; paths: boolean; catalogTruncated: boolean; scan?: SkillWorkspacePaths }): string {
  const eligible = skills.filter(skill => !skill.disableModelInvocation).sort((a, b) => a.name.localeCompare(b.name))
  const budget = { remaining: 2000000 }
  let matchLimited = false
  const matches = new Set<string>()
  if (options.paths && options.scan && !options.scan.unavailable) {
    try { for (const skill of eligible) if (skill.paths.length && skill.paths.some(pattern => options.scan!.paths.some(file => matchesThreadSkillPath(pattern, file, budget)))) matches.add(skill.id) }
    catch { matchLimited = true }
  }
  const entries: Array<{ id: string; name: string; description: string; pathMatched?: true }> = []
  let omitted = 0
  const envelope = () => ({ type: 'procedural-skill-metadata', untrustedData: true, grantsPermission: false, instructionsLoaded: false, indexEnabled: options.index, pathHintsEnabled: options.paths, scan: !options.paths ? 'disabled' : !options.scan || options.scan.unavailable ? 'unavailable' : options.scan.truncated || matchLimited ? 'partial' : 'bounded-scan', catalogTruncated: options.catalogTruncated, omitted, skills: entries })
  for (const skill of eligible) {
    if (!options.index && !matches.has(skill.id)) continue
    const item = { id: skill.id, name: skill.name, description: skill.description.split(/[\r\n]/, 1)[0].slice(0, 200), ...(matches.has(skill.id) ? { pathMatched: true as const } : {}) }
    entries.push(item)
    if (Buffer.byteLength(JSON.stringify(envelope())) > 4000) { entries.pop(); omitted++ }
  }
  const text = JSON.stringify(envelope())
  if (Buffer.byteLength(text) > 4096) throw new Error('Procedural skill context byte budget exceeded.')
  return text
}
