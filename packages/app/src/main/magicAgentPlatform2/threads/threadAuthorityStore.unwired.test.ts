import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')

const here = fileURLToPath(new URL('.', import.meta.url))
const src = resolve(here, '../../..')
const threadsDir = relative(src, here).split(sep).join('/').replace(/\/$/, '')
const MODULE_EXTENSIONS = /\.(ts|tsx|mts|cts)$/
const TEST_FILE = /\.test\.(ts|tsx|mts|cts)$/
/** Anything that names the store, its class or its record kinds. */
const MENTIONS = [/threadAuthority/i, /agent-thread-identity/, /agent-thread-run-grant/]
const WIRING_NEEDS_APPROVAL =
  "Wiring the thread authority records into production needs the owner's approval of the grant card first (alignment backlog item 54)."

function sources(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...sources(path))
    else if (MODULE_EXTENSIONS.test(name) && !TEST_FILE.test(name))
      found.push(relative(src, path).split(sep).join('/'))
  }
  return found
}

const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('thread authority records stay unwired', () => {
  it('no production file outside threads/ mentions the store or its record kinds', () => {
    const files = ['main', 'preload', 'shared', 'renderer'].flatMap((root) =>
      sources(join(src, root))
    )
    expect(files.length).toBeGreaterThan(500)
    expect(files).toContain(`${threadsDir}/threadAuthorityStore.ts`)
    const offenders = files.filter(
      (file) =>
        !file.startsWith(`${threadsDir}/`) &&
        MENTIONS.some((pattern) => pattern.test(readFileSync(join(src, file), 'utf8')))
    )
    expect(offenders, WIRING_NEEDS_APPROVAL).toEqual([])
  })

  it('threads/ holds no other production module that could re-export the store', () => {
    const own = sources(join(src, threadsDir))
    expect(own, WIRING_NEEDS_APPROVAL).toEqual([`${threadsDir}/threadAuthorityStore.ts`])
  })

  it('the store has one clock, one id source and nothing that starts work or talks to a window', () => {
    const code = stripComments(readFileSync(join(here, 'threadAuthorityStore.ts'), 'utf8'))
    const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]).sort()
    expect(imports, WIRING_NEEDS_APPROVAL).toEqual([
      '../persistence/eventStore',
      '@shared/agent',
      '@shared/api/agentThreadGoal',
      'node:crypto'
    ])
    expect(code.match(/Date\.now/g)).toHaveLength(1)
    expect(code.match(/randomUUID/g)).toHaveLength(2)
    expect(code.match(/\?\? Date\.now\b/g)).toHaveLength(1)
    expect(code.match(/\?\? randomUUID\b/g)).toHaveLength(1)
    // The approval verifier comes only from the caller: no default, no implementation here.
    expect(code.match(/verifyApproval\s*(=(?!=)|\?\?|\|\|)[^\n]*/g)).toEqual([
      'verifyApproval = options.verifyApproval'
    ])
    expect(code).not.toMatch(/export (const|function) verify/i)
    for (const forbidden of [
      /new Date\b/,
      /performance\.now/,
      /Math\.random/,
      /setTimeout|setInterval|setImmediate|queueMicrotask/,
      /electron|ipcMain|webContents|BrowserWindow/,
      /process\.on\b/,
      /require\(/,
      /import\(/
    ])
      expect(code, WIRING_NEEDS_APPROVAL).not.toMatch(forbidden)
  })
})
