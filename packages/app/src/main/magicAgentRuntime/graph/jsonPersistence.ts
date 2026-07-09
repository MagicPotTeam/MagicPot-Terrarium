import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const UTF8_BOM_PATTERN = /^\uFEFF/

export async function pathExists(targetPath: string): Promise<boolean> {
  return fs
    .stat(targetPath)
    .then(() => true)
    .catch(() => false)
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  const text = await fs.readFile(filePath, 'utf8')
  return JSON.parse(text.replace(UTF8_BOM_PATTERN, '')) as T
}

export async function readDirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => [])
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  )
  const data = `${JSON.stringify(value, null, 2)}\n`
  try {
    await fs.writeFile(tempPath, data, 'utf8')
    await fs.rename(tempPath, filePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export const normalizePathSeparators = (input: string): string => input.replace(/\\/g, '/')

export function assertPathWithinRoot(rootDir: string, candidatePath: string): void {
  const root = path.resolve(rootDir)
  const candidate = path.resolve(candidatePath)
  const relative = normalizePathSeparators(path.relative(root, candidate))
  if (
    relative === '' ||
    (!relative.startsWith('../') && relative !== '..' && !path.isAbsolute(relative))
  ) {
    return
  }
  throw new Error('Path escapes MagicAgentGraph store root.')
}
