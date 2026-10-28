import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// This CLI integration suite creates disposable real files for child Node/Git processes.
// The node suite's global memfs cannot be shared with those processes.
vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const scriptPath = path.resolve(process.cwd(), 'scripts/check-text-encoding.mjs')
const nodePath = process.execPath

function runCheck(cwd, ...files) {
  return execFileSync(nodePath, [scriptPath, ...files], { cwd, encoding: 'utf8' })
}

function runCheckResult(cwd, ...files) {
  try {
    return { status: 0, stdout: runCheck(cwd, ...files) }
  } catch (error) {
    return {
      status: error.status,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? ''
    }
  }
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

      expect(runCheck(dir, file)).toContain('Encoding check passed')
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

      expect(() => runCheck(dir, file)).toThrow(/Found suspicious encoding or placeholder text/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('checks Python UTF-8 and replacement characters instead of silently filtering the extension', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'magicpot-encoding-python-'))
    try {
      const file = path.join(dir, 'owned_runtime.py')
      writeFileSync(file, '# Local reader: 选区\nvalue = "actual"\n', 'utf8')
      expect(runCheck(dir, file)).toContain('Encoding check passed (1 files).')
      writeFileSync(file, Buffer.from([0xc3, 0x28]))
      expect(runCheckResult(dir, file).status).toBe(1)
      writeFileSync(file, 'label = "\uFFFD"\n', 'utf8')
      expect(runCheckResult(dir, '--all').status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flags full-line Python hash-comment placeholders and mojibake without changing byte checks', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'magicpot-encoding-python-comments-'))
    try {
      const file = path.join(dir, 'owned_runtime.PY')
      for (const comment of ['# ?? placeholder', '  # \u941c\u95ae']) {
        writeFileSync(file, `${comment}\nvalue = "actual"\n`, 'utf8')
        const result = runCheckResult(dir, file)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('owned_runtime.PY:1 suspicious mojibake detected')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps legitimate Python strings, inline hash text and normal Unicode outside the comment heuristic', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'magicpot-encoding-python-legitimate-'))
    try {
      const file = path.join(dir, 'reader.py')
      writeFileSync(
        file,
        [
          '# 本地只读采集：选区与图层',
          'label = "# ??"',
          'message = "\u941c\u95ae"',
          'result = "ok"  # ?? inline checks remain out of scope',
          ''
        ].join('\n'),
        'utf8'
      )
      expect(runCheck(dir, file)).toContain('Encoding check passed (1 files).')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not treat non-Python hash headings as Python comments or traverse skipped vendor Python', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'magicpot-encoding-python-scope-'))
    try {
      const heading = path.join(dir, 'notes.md')
      writeFileSync(heading, '# ?? question heading\n', 'utf8')
      mkdirSync(path.join(dir, 'vendor'))
      writeFileSync(path.join(dir, 'vendor', 'third_party.py'), '# ?? placeholder\n', 'utf8')
      expect(runCheck(dir, '--all')).toContain('Encoding check passed (1 files).')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves the pinned baseline suspicious-character coverage in JS and Python full-line comments', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'magicpot-encoding-baseline-table-'))
    const historicalCodes = [
      0x30e7, 0x790c, 0x93c9, 0x612e, 0x6b91, 0x93b5, 0x64b4, 0x7223, 0x5a0c, 0x590b, 0x8e48,
      0x5fd4, 0x7161
    ]
    try {
      for (const extension of ['ts', 'py']) {
        const file = path.join(dir, `comment.${extension}`)
        for (const code of historicalCodes) {
          const text = String.fromCodePoint(code)
          const comment = extension === 'py' ? `# ${text}` : `/* ${text} */`
          writeFileSync(file, `${comment}\n`, 'utf8')
          expect(runCheckResult(dir, file).status).toBe(1)
          writeFileSync(file, `label = "${text}"\n`, 'utf8')
          expect(runCheckResult(dir, file).status).toBe(0)
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('fails a default scan when there are no text files', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'magicpot-encoding-empty-'))

    try {
      const result = runCheckResult(dir)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Encoding check failed (no text files found).')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('walks an ignored nested materialization, rejects bad UTF-8 and comments, and does not follow symlinks', () => {
    const outer = mkdtempSync(path.join(os.tmpdir(), 'magicpot-encoding-outer-'))
    const cwd = path.join(outer, 'open-copy')
    const escape = path.join(outer, 'escape')
    mkdirSync(path.join(cwd, 'nested'), { recursive: true })
    mkdirSync(escape)

    try {
      execFileSync('git', ['init', '-q'], { cwd: outer })
      writeFileSync(path.join(outer, 'tracked.txt'), 'tracked\n', 'utf8')
      execFileSync('git', ['add', 'tracked.txt'], { cwd: outer })

      writeFileSync(path.join(cwd, 'nested', 'bad-comment.ts'), '/** ??? */\n', 'utf8')
      writeFileSync(path.join(cwd, 'nested', 'bad-utf8.txt'), Buffer.from([0xc3, 0x28]))
      writeFileSync(path.join(escape, 'outside.ts'), '/** ??? escaped */\n', 'utf8')
      let symlinkCreated = false
      try {
        symlinkSync(escape, path.join(cwd, 'linked-escape'), 'junction')
        symlinkCreated = true
      } catch (error) {
        if (!error || typeof error !== 'object' || !['EPERM', 'EACCES'].includes(error.code)) {
          throw error
        }
      }

      const result = runCheckResult(cwd)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(path.join('nested', 'bad-comment.ts'))
      expect(result.stderr).toContain(path.join('nested', 'bad-utf8.txt'))
      if (symlinkCreated) {
        expect(result.stderr).not.toContain('outside.ts')
      }
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
  })

  it('fails an empty --all scan while preserving explicit deleted-file handling', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'magicpot-encoding-all-empty-'))
    try {
      expect(runCheckResult(dir, '--all').status).toBe(1)
      expect(runCheckResult(dir, path.join(dir, 'deleted.ts')).status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('includes untracked text with --all even at a real Git root', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'magicpot-encoding-all-git-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      writeFileSync(path.join(dir, 'tracked.ts'), 'const ok = true\n', 'utf8')
      execFileSync('git', ['add', 'tracked.ts'], { cwd: dir })
      writeFileSync(path.join(dir, 'untracked.ts'), '/** ??? */\n', 'utf8')
      const result = runCheckResult(dir, '--all')
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('untracked.ts')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses tracked files for a real Git root', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'magicpot-encoding-git-'))

    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      writeFileSync(path.join(dir, 'tracked.ts'), 'const ok = true\n', 'utf8')
      writeFileSync(path.join(dir, 'untracked.ts'), '/** ??? */\n', 'utf8')
      execFileSync('git', ['add', 'tracked.ts'], { cwd: dir })

      expect(runCheck(dir)).toContain('Encoding check passed (1 files).')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
