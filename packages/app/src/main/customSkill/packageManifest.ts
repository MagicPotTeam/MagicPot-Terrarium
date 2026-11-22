/* eslint-disable no-control-regex -- Reject device, traversal and control-byte paths in untrusted manifests. */
import { isAlias, isCollection, isMap, isNode, isScalar, parseDocument, visit } from 'yaml'
import { cloneBoundedMcpJson } from '@shared/api/agentThreadMcp'
import { THREAD_SKILL_LIMITS as LIMITS } from '@shared/api/agentThreadSkill'

export type DeclaredPackageSkill = { name: string; path: string; description: string }
/** Deliberately portable subset, not a URL or a permission to read outside the selected root. */
export function isPackageSkillRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 512 || value.startsWith('/') || /[\\:\u0000-\u001f\u007f?*<>"|]/.test(value)) return false
  const parts = value.split('/')
  return parts.length <= 16 && parts.every(part => part.length > 0 && part.length <= 128 && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}
/** Only the skills slot is interpreted. Dependencies/modules/plugins/commands are inert data.
 * Stricter than upstream: malformed/ambiguous declarations reject this manifest, not a scan fallback. */
export function parseSkillPackageManifest(source: string): DeclaredPackageSkill[] {
  if (typeof source !== 'string' || Buffer.byteLength(source) > LIMITS.fileBytes || source.includes('\0')) throw new Error('Procedural skill manifest exceeds limits.')
  const document = parseDocument(source.replace(/^\uFEFF/, ''), { schema: 'core', version: '1.2', customTags: [], uniqueKeys: true, strict: true, prettyErrors: false })
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) throw new Error('Procedural skill manifest must be a valid YAML mapping.')
  let nodes = 0
  visit(document, (_key, node, ancestry) => {
    if (++nodes > 4096 || ancestry.length > 16 || isAlias(node) || isNode(node) && node.tag || (isScalar(node) || isCollection(node)) && node.anchor) throw new Error('Procedural skill manifest aliases/tags/anchors or structure are unsupported.')
  })
  let data: Record<string, unknown>
  try { data = cloneBoundedMcpJson(document.toJS({ maxAliasCount: 0 }), LIMITS.fileBytes) as Record<string, unknown> }
  catch { throw new Error('Procedural skill manifest must contain bounded passive data.') }
  const entries = data.skills ?? []
  if (!Array.isArray(entries) || entries.length > LIMITS.files) throw new Error('Procedural skill manifest declarations exceed limits.')
  const names = new Set<string>(), paths = new Set<string>()
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['name', 'path', 'description'].includes(key)) || typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(entry.name) || !isPackageSkillRelativePath(entry.path) || entry.description !== undefined && (typeof entry.description !== 'string' || entry.description.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry.description))) throw new Error('Procedural skill manifest declaration is invalid.')
    // Filesystem spelling must not decide which declaration wins on another OS.
    const pathKey = entry.path.toLowerCase()
    if (names.has(entry.name) || paths.has(pathKey)) throw new Error('Procedural skill manifest declarations are ambiguous.')
    names.add(entry.name); paths.add(pathKey)
    return { name: entry.name, path: entry.path, description: entry.description ?? '' }
  })
}
