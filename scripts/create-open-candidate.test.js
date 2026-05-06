import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  auditOpenCandidate,
  createOpenCandidate,
  getOpenCandidateExclusionReason,
  hasGitRepository,
  runVerifyMode
} from './create-open-candidate.mjs'

const possiblePrivateRepoRoot = path.resolve(process.cwd(), '..', '..')
const workspaceRoot =
  path.basename(path.dirname(process.cwd())) === 'open' &&
  fs.existsSync(path.join(possiblePrivateRepoRoot, 'private', 'codex'))
    ? possiblePrivateRepoRoot
    : process.cwd()
const trashRoot = path.join(workspaceRoot, '.magicpot-trash')
const testRoots = []

const makeCandidate = () => {
  fs.mkdirSync(trashRoot, { recursive: true })
  const dir = fs.mkdtempSync(path.join(trashRoot, 'candidate-audit-test-'))
  testRoots.push(dir)
  return dir
}

const writeFile = (root, relativePath, content) => {
  const file = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

const withFakeGitLsFiles = (trackedFiles, callback) => {
  const bin = makeCandidate()
  const listPath = path.join(bin, 'ls-files.bin')
  const records = trackedFiles.map(
    (file) => `${file.mode ?? '100644'} 0000000000000000000000000000000000000000 0\t${file.path}`
  )
  fs.writeFileSync(listPath, `${records.join('\0')}\0`, 'utf8')

  const previousFakeGitLsFiles = process.env.MAGICPOT_FAKE_GIT_LS_FILES
  process.env.MAGICPOT_FAKE_GIT_LS_FILES = listPath
  try {
    return callback()
  } finally {
    if (previousFakeGitLsFiles === undefined) {
      delete process.env.MAGICPOT_FAKE_GIT_LS_FILES
    } else {
      process.env.MAGICPOT_FAKE_GIT_LS_FILES = previousFakeGitLsFiles
    }
  }
}

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('create-open-candidate policy', () => {
  it('excludes local auth, private env files, generated output, and VC redist', () => {
    expect(getOpenCandidateExclusionReason('.env.pure')).toBe('.env policy')
    expect(getOpenCandidateExclusionReason('.env.embedded')).toBe('.env policy')
    expect(getOpenCandidateExclusionReason('.env.example')).toBeNull()
    expect(getOpenCandidateExclusionReason('.env.sample')).toBeNull()
    expect(getOpenCandidateExclusionReason('.npmrc')).toBe('npm auth/config file')
    expect(getOpenCandidateExclusionReason('.eslintcache')).toBe(
      'generated dependency/build output'
    )
    expect(getOpenCandidateExclusionReason('.magicpot-trash/run/log.txt')).toBe(
      'local generated artifacts'
    )
    expect(getOpenCandidateExclusionReason('.git')).toBe('git metadata')
    expect(getOpenCandidateExclusionReason('auth.json')).toBe('local auth material')
    expect(getOpenCandidateExclusionReason('cookies.txt')).toBe('local auth material')
    expect(getOpenCandidateExclusionReason('node_modules')).toBe(
      'generated dependency/build output'
    )
    expect(getOpenCandidateExclusionReason('out')).toBe('generated dependency/build output')
    expect(getOpenCandidateExclusionReason('node_modules/pkg/index.js')).toBe(
      'generated dependency/build output'
    )
    expect(getOpenCandidateExclusionReason('vendor/windows/VC_redist.x64.exe')).toBe(
      'Microsoft VC Redistributable licensing blocker'
    )
  })

  it('allows draco decoder assets without treating dense JS as a secret', () => {
    const candidate = makeCandidate()
    writeFile(
      candidate,
      'packages/app/src/renderer/public/three/draco/gltf/draco_decoder.js',
      'var Module = Module || {}; var payload = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(20);'
    )

    expect(auditOpenCandidate(candidate)).toEqual([])
  })

  it('reports generated root artifacts in an already-generated candidate', () => {
    const candidate = makeCandidate()
    fs.mkdirSync(path.join(candidate, 'node_modules'), { recursive: true })
    fs.mkdirSync(path.join(candidate, 'out'), { recursive: true })
    writeFile(candidate, '.eslintcache', '{}\n')

    expect(auditOpenCandidate(candidate)).toEqual(
      expect.arrayContaining([
        {
          file: '.eslintcache',
          line: 1,
          rule: 'forbidden-candidate-file',
          message: 'generated dependency/build output'
        },
        {
          file: 'node_modules',
          line: 1,
          rule: 'forbidden-candidate-file',
          message: 'generated dependency/build output'
        },
        {
          file: 'out',
          line: 1,
          rule: 'forbidden-candidate-file',
          message: 'generated dependency/build output'
        }
      ])
    )
  })

  it('reports candidate blockers with file, line, and rule', () => {
    const candidate = makeCandidate()
    const codexServiceName = 'svc' + 'CodexAuth'
    const privatePath = 'private' + '/internal'
    const apiToken = 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456'

    writeFile(
      candidate,
      'packages/app/src/main/api/server.ts',
      `const svc = "${codexServiceName}"\n`
    )
    writeFile(candidate, 'docs/path.md', `Do not point users at ${privatePath} paths.\n`)
    writeFile(candidate, 'config/token.txt', `OPENAI_API_KEY=${apiToken}\n`)

    expect(auditOpenCandidate(candidate)).toEqual([
      {
        file: 'config/token.txt',
        line: 1,
        rule: 'high-confidence-secret',
        message: apiToken
      },
      {
        file: 'docs/path.md',
        line: 1,
        rule: 'private-path-reference',
        message: ` ${privatePath}`
      },
      {
        file: 'packages/app/src/main/api/server.ts',
        line: 1,
        rule: 'codex-functional-reference',
        message: codexServiceName
      }
    ])
  })

  it('verifies an already-generated candidate even when it is not a git repository', () => {
    const candidate = makeCandidate()
    writeFile(candidate, 'README.md', '# MagicPot Open\n')
    writeFile(candidate, 'scripts/create-open-candidate.mjs', 'export {}\n')

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = runVerifyMode({ sourceRoot: candidate })

    expect(hasGitRepository(candidate)).toBe(false)
    expect(result).toEqual({ candidatePath: candidate, auditCurrent: true })
    expect(logSpy).toHaveBeenCalledWith('Open candidate audit passed.')
    expect(logSpy).toHaveBeenCalledWith(`Verified current candidate: ${candidate}`)

    logSpy.mockRestore()
  })

  it('can generate from an explicit public source repository', () => {
    const source = makeCandidate()
    const output = makeCandidate()
    const blockedDir = 'pri' + 'vate'
    const blockedPath = `${blockedDir}/codex.txt`
    writeFile(source, 'README.md', '# MagicPot Open\n')
    writeFile(source, 'packages/app/src/index.ts', 'export const appName = "MagicPot"\n')
    writeFile(source, '.npmrc', '//registry.example.test/:_authToken=ignored\n')
    writeFile(source, blockedPath, 'overlay file\n')

    const result = withFakeGitLsFiles(
      [
        { path: '.npmrc' },
        { path: 'README.md' },
        { path: 'packages/app/src/index.ts' },
        { path: blockedPath }
      ],
      () => createOpenCandidate(output, source)
    )

    expect(result.candidatePath).toBe(output)
    expect(fs.existsSync(path.join(output, 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(output, 'packages/app/src/index.ts'))).toBe(true)
    expect(fs.existsSync(path.join(output, '.npmrc'))).toBe(false)
    expect(fs.existsSync(path.join(output, blockedPath))).toBe(false)
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { file: '.npmrc', reason: 'npm auth/config file' },
        { file: blockedPath, reason: 'open/private workspace wrapper' }
      ])
    )
  })
})
