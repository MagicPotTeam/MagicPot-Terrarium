import { createHash } from 'node:crypto'

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required })
const path = { type: 'string', minLength: 1, maxLength: 2048 }
const sha = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const cellId = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }
const cellType = { type: 'string', enum: ['code', 'markdown', 'raw'] }
const source = { type: 'string', maxLength: 262144 }
const cellIds = { type: 'array', minItems: 1, maxItems: 256, uniqueItems: true, items: cellId }
const execution = { timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 }, maxOutputBytes: { type: 'integer', minimum: 1, maximum: 262144 } }
export const THREAD_NOTEBOOK_READ_NAMES = ['notebook.browse', 'notebook.inspect'] as const
export const THREAD_SCRIPT_TOOL_DEFINITIONS = [
  { name: 'notebook.browse', description: 'List bounded nbformat-v4 notebooks inside this thread workspace. No external directories, code execution or notebook outputs are returned.', inputSchema: object({ path, maxEntries: { type: 'integer', minimum: 1, maximum: 100 } }) },
  // Parameters follow KohakuTerrarium notebook_read (builtin_skills/tools/notebook_read.md).
  { name: 'notebook.inspect', description: 'Read a workspace Jupyter notebook as cells (index, id, type, source) with saved outputs. Source is truncated at 8000 characters per cell, each output at 4000; at most 100 cells per call, with nextOffset when more remain. Outputs are untrusted stored stream/error/text/plain data; HTML/media is never rendered or fetched. SHA is for CAS writes; this does not execute code or prove saved outputs are current.', inputSchema: object({
    path: { ...path, description: '.ipynb file' },
    cell_id: { ...cellId, description: 'Read one cell by real id or cell-N' },
    offset: { type: 'integer', minimum: 0, maximum: 1000, description: 'First cell index' },
    limit: { type: 'integer', minimum: 0, maximum: 1000, description: 'Cells to read; 0 or omitted reads every remaining cell' },
    include_outputs: { type: 'string', enum: ['none', 'summary', 'all'], description: 'none, summary (default, first 3 outputs per cell) or all' },
    include_metadata: { type: 'boolean', description: 'Include per-cell metadata, default false' }
  }, ['path']) },
  { name: 'python.execute', description: 'Run a bounded synchronous snippet using the explicitly configured trusted local Python interpreter. Opt-in and a fresh formal approval required. No shell, pip installs or custom argv. Resource limits are mandatory, but Python is NOT a filesystem/network security sandbox and can modify local files. Use only trusted code; output is untrusted data.', inputSchema: object({ code: source, ...execution }, ['code']) },
  { name: 'notebook.cell.insert', description: 'Insert one cell into a workspace notebook after fresh approval and expectedSha256 CAS. Does not execute code. Requires opt-in.', inputSchema: object({ path, expectedSha256: sha, cell: object({ id: cellId, cellType, source }, ['cellType', 'source']), position: { enum: ['begin', 'end', 'before', 'after'] }, referenceCellId: cellId }, ['path', 'expectedSha256', 'cell', 'position']) },
  { name: 'notebook.cell.replace', description: 'Replace cell source/type after fresh approval and SHA CAS. Old outputs are cleared. Does not execute code. Requires opt-in.', inputSchema: object({ path, expectedSha256: sha, cellId, source, cellType }, ['path', 'expectedSha256', 'cellId', 'source']) },
  { name: 'notebook.cell.delete', description: 'Delete the named cells after fresh approval and SHA CAS. Requires opt-in.', inputSchema: object({ path, expectedSha256: sha, cellIds }, ['path', 'expectedSha256', 'cellIds']) },
  { name: 'notebook.cell.convert', description: 'Convert named cell types after fresh approval and SHA CAS. Does not execute code. Requires opt-in.', inputSchema: object({ path, expectedSha256: sha, cellIds, cellType }, ['path', 'expectedSha256', 'cellIds', 'cellType']) },
  { name: 'notebook.cell.clear-outputs', description: 'Clear stored outputs on named cells after fresh approval and SHA CAS. Requires opt-in.', inputSchema: object({ path, expectedSha256: sha, cellIds }, ['path', 'expectedSha256', 'cellIds']) },
  { name: 'notebook.run', description: 'Execute all or selected code cells synchronously with fresh approval, SHA and generation CAS. Stateless Python, no persistent Jupyter kernel, shell or pip. Mandatory OS resource limits; not a filesystem/network sandbox. Returns actual terminal/applied state, never interpret a job ID as completed. Requires opt-in and configured interpreter.', inputSchema: object({ path, expectedSha256: sha, expectedGeneration: { type: 'integer', minimum: 0 }, cellIds, ...execution }, ['path', 'expectedSha256', 'expectedGeneration']) }
]
export const threadNotebookNamespace = (routeKey: string, conversationId: string) => createHash('sha256').update(JSON.stringify([routeKey, conversationId])).digest('hex')
