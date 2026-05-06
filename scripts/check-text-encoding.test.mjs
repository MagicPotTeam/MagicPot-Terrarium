import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const scriptPath = path.resolve(process.cwd(), 'scripts/check-text-encoding.mjs')

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function runCheck(...files) {
  return execFileSync('node', [scriptPath, ...files], { encoding: 'utf8' })
}

describe('check-text-encoding', () => {
  it('does not flag normal code with ternaries or nullish coalescing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'magicpot-encoding-ok-'))
    const file = path.join(dir, 'normal.ts')

    try {
      writeFileSync(
        file,
        [
          'const value = flag ? left : right',
          'const fallback = value ?? defaultValue',
          'const label = "???"',
          ''
        ].join('\n'),
        'utf8'
      )

      expect(runCheck(file)).toContain('Encoding check passed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags question-mark placeholders in comments and JSDoc', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'magicpot-encoding-bad-'))
    const file = path.join(dir, 'placeholder.ts')

    try {
      writeFileSync(
        file,
        ['/**', ' * ??? placeholder ???', ' */', 'const value = flag ? left : right', ''].join(
          '\n'
        ),
        'utf8'
      )

      expect(() => runCheck(file)).toThrow(/Found suspicious encoding or placeholder text/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
