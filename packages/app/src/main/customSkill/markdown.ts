import { isAlias, isCollection, isMap, isNode, isScalar, parseDocument, visit } from 'yaml'
import { isThreadSkillPattern, THREAD_SKILL_LIMITS as LIMITS } from '@shared/api/agentThreadSkill'
import { cloneBoundedMcpJson } from '@shared/api/agentThreadMcp'

export type ParsedSkillMarkdown = { name: string; description: string; instructions: string; paths: string[]; disableModelInvocation: boolean; metadataFields: string[] }
/** Passive YAML/Markdown only. No template substitution, hooks or tool grants. */
export function parseSkillMarkdown(source: string, defaultName: string, defaultDescription = ''): ParsedSkillMarkdown {
  if (typeof source !== 'string' || Buffer.byteLength(source) > LIMITS.fileBytes || source.includes('\0')) throw new Error('Procedural skill Markdown exceeds limits.')
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  let body = text, metadata: Record<string, unknown> = {}
  if (text.startsWith('---\n')) {
    const ending = /^---[ \t]*$/gm; ending.lastIndex = 4
    const end = ending.exec(text)
    if (!end || end.index > 8192) throw new Error('Procedural skill frontmatter is missing or exceeds limits.')
    const header = text.slice(4, end.index)
    if (Buffer.byteLength(header) > 8192) throw new Error('Procedural skill frontmatter exceeds byte limits.')
    const doc = parseDocument(header, { schema: 'core', version: '1.2', customTags: [], uniqueKeys: true, strict: true, prettyErrors: false })
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) throw new Error('Procedural skill frontmatter must be a valid YAML mapping.')
    let nodes = 0
    visit(doc, (_key, node, path) => {
      if (++nodes > 256 || path.length > 12 || isAlias(node) || isNode(node) && node.tag || (isScalar(node) || isCollection(node)) && node.anchor) throw new Error('Procedural skill frontmatter aliases/tags/anchors or structure are unsupported.')
    })
    try { metadata = cloneBoundedMcpJson(doc.toJS({ maxAliasCount: 0 }), 8192) as Record<string, unknown> }
    catch { throw new Error('Procedural skill frontmatter must contain bounded passive data.') }
    body = text.slice(end.index + end[0].length).replace(/^\n/, '')
  }
  const name = metadata.name ?? defaultName, description = metadata.description ?? defaultDescription
  const paths = typeof metadata.paths === 'string' ? metadata.paths.split(',').map(part => part.trim()).filter(Boolean) : metadata.paths ?? []
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) || typeof description !== 'string' || description.length > 1000 || !Array.isArray(paths) || paths.length > LIMITS.patterns || !paths.every(isThreadSkillPattern) || metadata['disable-model-invocation'] !== undefined && typeof metadata['disable-model-invocation'] !== 'boolean') throw new Error('Procedural skill Markdown metadata is invalid.')
  const instructions = body.trim()
  if (!instructions || instructions.length > LIMITS.bodyCharacters) throw new Error('Procedural skill Markdown body is empty or exceeds limits.')
  return { name, description, instructions, paths: [...paths], disableModelInvocation: metadata['disable-model-invocation'] === true, metadataFields: Object.keys(metadata).filter(key => !['name', 'description', 'paths', 'disable-model-invocation'].includes(key)).sort() }
}
