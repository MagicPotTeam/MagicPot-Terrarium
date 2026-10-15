import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
import {
  auditOpenCandidate,
  auditOpenWorktree,
  createOpenCandidate,
  getOpenCandidateExclusionReason,
  hasGitRepository,
  resolveTrashCandidatePath,
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
const privateExtensionDirectory = 'private' + 'Extensions'
const chatWebRule = 'chat' + 'gpt' + '-web'

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
  const mock = vi.mocked(execFileSync)
  const previous = mock.getMockImplementation()
  mock.mockImplementation((_command, args, options) => {
    if (args[0] === 'rev-parse') return `${path.resolve(options.cwd)}\n`
    if (args.includes('--stage')) {
      return trackedFiles
        .map(
          (file) =>
            `${file.mode ?? '100644'} 0000000000000000000000000000000000000000 0\t${file.path}\0`
        )
        .join('')
    }
    if (args.includes('ls-files')) return trackedFiles.map((file) => `${file.path}\0`).join('')
    throw new Error(`Unexpected Git command: ${args.join(' ')}`)
  })
  try {
    return callback()
  } finally {
    mock.mockImplementation(previous)
  }
}

beforeEach(() => {
  vi.mocked(execFileSync)
    .mockReset()
    .mockImplementation(() => {
      throw new Error('Not a Git repository')
    })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
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

  it('rejects declared private source paths without broad private keyword matching', () => {
    const neutralPrivateSegment = privateExtensionDirectory
    const codexClientPathName = 'codex' + 'Chat' + 'Client.ts'
    expect(
      getOpenCandidateExclusionReason(`packages/app/src/main/${neutralPrivateSegment}/neutral.ts`)
    ).toBe('declared private source implementation')
    expect(
      getOpenCandidateExclusionReason(`packages/app/src/main/api/${codexClientPathName}`)
    ).toBe('declared private source implementation')
    expect(
      getOpenCandidateExclusionReason('packages/app/src/shared/llm/modelCatalog.ts')
    ).toBeNull()
    expect(getOpenCandidateExclusionReason('docs/private-api.md')).toBeNull()
    expect(getOpenCandidateExclusionReason('tests/private-fixture.ts')).toBeNull()
  })

  it('audits Python runtime sources with the same private-code and secret rules', () => {
    const candidate = makeCandidate()
    const serviceName = 'svc' + 'CodexAuth'
    const apiToken = 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456'
    const relative = 'packages/runtime-assets/resources/comfy/nodes/extension.py'
    writeFile(candidate, relative, `SERVICE = "${serviceName}"\nTOKEN = "${apiToken}"\n`)
    expect(auditOpenCandidate(candidate)).toEqual([
      { file: relative, line: 1, rule: 'codex-functional-reference', message: serviceName },
      { file: relative, line: 2, rule: 'high-confidence-secret', message: apiToken }
    ])
    writeFile(candidate, relative, 'def remove_background(image):\n    return image\n')
    expect(auditOpenCandidate(candidate)).toEqual([])
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

  it('scans private paths in test fixtures and distinguishes PEM markers from keys', () => {
    const candidate = makeCandidate()
    const completePem = [
      '-----BEGIN PRIVATE KEY-----',
      'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789=',
      '-----END PRIVATE KEY-----'
    ].join('\n')

    const privateFixturePath = '/' + 'private' + '/path'
    writeFile(
      candidate,
      'packages/app/src/example.test.ts',
      `const fixture = '${privateFixturePath}'\n`
    )
    writeFile(
      candidate,
      'packages/app/src/example.ts',
      "const marker = '-----BEGIN PRIVATE KEY-----'\n"
    )

    const pathIssue = {
      file: 'packages/app/src/example.test.ts',
      line: 1,
      rule: 'private-path-reference',
      message: privateFixturePath
    }
    expect(auditOpenCandidate(candidate)).toEqual([pathIssue])
    expect(
      auditOpenWorktree(candidate, { exec: () => 'packages/app/src/example.test.ts\0' })
    ).toEqual([pathIssue])

    writeFile(candidate, 'config/private-key.pem', completePem)
    expect(auditOpenCandidate(candidate)).toEqual([
      {
        file: 'config/private-key.pem',
        line: 1,
        rule: 'high-confidence-secret',
        message: completePem
      },
      pathIssue
    ])
  })

  it('continues to reject private paths outside test fixtures', () => {
    const candidate = makeCandidate()
    const windowsPath = ['C:', 'workspace', 'internal', 'config.json'].join(String.fromCharCode(92))
    const privateFixturePath = '/' + 'private' + '/path'
    writeFile(
      candidate,
      'packages/app/src/runtime.ts',
      `const posixPath = '${privateFixturePath}'\nconst windowsPath = '${windowsPath}'\n`
    )

    expect(auditOpenCandidate(candidate)).toEqual([
      {
        file: 'packages/app/src/runtime.ts',
        line: 1,
        rule: 'private-path-reference',
        message: privateFixturePath
      },
      {
        file: 'packages/app/src/runtime.ts',
        line: 2,
        rule: 'private-path-reference',
        message: windowsPath
      }
    ])
  })

  it('allows scoped package names containing internal in lockfile URLs', () => {
    const candidate = makeCandidate()
    writeFile(
      candidate,
      'package-lock.json',
      '{"resolved":"https://registry.npmjs.org/@electron-internal/extract-zip/-/extract-zip-1.0.5.tgz"}'
    )

    expect(auditOpenCandidate(candidate)).toEqual([])
  })

  it('rejects private ChatGPT Web content while allowing generic OpenAI docs and public markers', () => {
    const candidate = makeCandidate()
    const webToken = 'Chat' + 'GPT' + 'Web'
    const hyphenToken = 'chat' + 'gpt' + '-web'
    const serviceToken = 'svc' + webToken
    const origin = 'https://' + 'chat' + 'gpt' + '.com/c/example'
    const partitionMarker = 'SESSION_' + 'PARTITION'
    const domMarker = '__magicpot' + webToken + 'Request'
    writeFile(
      candidate,
      'packages/app/src/main/webClient.ts',
      [
        `const implementation = '${webToken}'`,
        `const service = '${serviceToken}'`,
        `const endpoint = '${origin}'`,
        `const route = '${hyphenToken}/conversation'`,
        `const partition = '${partitionMarker}'`,
        `const bridge = '${domMarker}'`
      ].join('\n')
    )

    const issues = auditOpenCandidate(candidate)
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'packages/app/src/main/webClient.ts',
          rule: `${chatWebRule}-functional-reference`,
          message: webToken
        }),
        expect.objectContaining({
          file: 'packages/app/src/main/webClient.ts',
          rule: `${chatWebRule}-functional-reference`,
          message: hyphenToken
        }),
        expect.objectContaining({
          file: 'packages/app/src/main/webClient.ts',
          rule: `${chatWebRule}-origin-reference`,
          message: origin.slice(0, origin.indexOf('/c/'))
        }),
        expect.objectContaining({
          file: 'packages/app/src/main/webClient.ts',
          rule: `${chatWebRule}-session-reference`,
          message: partitionMarker
        }),
        expect.objectContaining({
          file: 'packages/app/src/main/webClient.ts',
          rule: `${chatWebRule}-dom-bridge-reference`,
          message: '__magicpot' + webToken
        })
      ])
    )

    const safeCandidate = makeCandidate()
    writeFile(
      safeCandidate,
      'docs/openai.md',
      'OpenAI API documentation: https://platform.openai.com/docs\nGeneric session partition IPC documentation.\n<!-- magicpot-release: public -->\n'
    )
    expect(auditOpenCandidate(safeCandidate)).toEqual([])
  })

  it.each([
    'packages/app/src/main/api/' + 'codex' + 'Chat' + 'Client.ts',
    'packages/app/src/main/api/svc' + 'CodexAuthImpl.test.ts',
    'packages/app/src/main/api/svcLLMProxyCodexStreaming.integration.test.ts',
    'packages/app/src/main/' + privateExtensionDirectory + '/codexMainExtension.ts',
    'packages/app/src/main/llmProxy/codexAttachmentArtifacts.ts',
    'packages/app/src/renderer/src/' + privateExtensionDirectory + '/codexRendererExtension.tsx',
    'packages/app/src/shared/' + privateExtensionDirectory + '/codexSharedExtension.ts',
    'packages/app/src/shared/llm/profileHelpers.ts',
    'tests/provider-fixture.test.ts'
  ])('never trusts a provider filename or test directory: %s', (relativeFile) => {
    const candidate = makeCandidate()
    const token = 'svc' + 'CodexAuth'
    writeFile(candidate, relativeFile, `export const service = '${token}'\n`)
    const declaredPrivate =
      getOpenCandidateExclusionReason(relativeFile) === 'declared private source implementation'
    const expectedWorktree = declaredPrivate
      ? expect.arrayContaining([
          expect.objectContaining({ file: relativeFile, rule: 'forbidden-candidate-file' })
        ])
      : expect.arrayContaining([
          expect.objectContaining({ file: relativeFile, rule: 'codex-functional-reference' })
        ])
    const expectedCandidate = declaredPrivate
      ? expect.arrayContaining([expect.objectContaining({ rule: 'forbidden-candidate-file' })])
      : expectedWorktree
    expect(auditOpenCandidate(candidate)).toEqual(expectedCandidate)
    expect(auditOpenWorktree(candidate, { exec: () => `${relativeFile}\0` })).toEqual(
      expectedWorktree
    )
  })

  it.each([
    'packages/app/src/main/api/svc',
    'packages/app/src/main/llmProxy/',
    'packages/app/src/main/' + privateExtensionDirectory + '/',
    'packages/app/src/shared/' + privateExtensionDirectory + '/',
    'packages/app/src/renderer/src/' + privateExtensionDirectory + '/',
    'packages/app/src/shared/api/svc',
    'packages/app/src/renderer/src/pages/SettingsPage/',
    'packages/app/src/shared/locales/en-US/',
    'packages/app/src/shared/locales/zh-CN/'
  ])('rejects private web provider files even under %s', (prefix) => {
    const candidate = makeCandidate()
    const relativeFile = `${prefix}${'chat' + 'gpt' + 'Web'}Implementation.test.ts`
    writeFile(candidate, relativeFile, 'export {}\n')
    const expectedWorktree =
      getOpenCandidateExclusionReason(relativeFile) === 'declared private source implementation'
        ? expect.arrayContaining([
            expect.objectContaining({ file: relativeFile, rule: 'forbidden-candidate-file' })
          ])
        : expect.arrayContaining([
            expect.objectContaining({ file: relativeFile, rule: `${chatWebRule}-filename` })
          ])
    const expectedCandidate =
      getOpenCandidateExclusionReason(relativeFile) === 'declared private source implementation'
        ? expect.arrayContaining([expect.objectContaining({ rule: 'forbidden-candidate-file' })])
        : expectedWorktree
    expect(auditOpenCandidate(candidate)).toEqual(expectedCandidate)
    expect(auditOpenWorktree(candidate, { exec: () => `${relativeFile}\0` })).toEqual(
      expectedWorktree
    )
  })

  it.each([
    'packages/app/src/shared/extensions/generatedRegistry.ts',
    'packages/app/src/main/extensions/generatedRegistry.ts',
    'packages/app/src/renderer/src/extensions/generatedRegistry.tsx',
    'packages/app/src/main/neutral.test.ts'
  ])('rejects private extension imports consistently in %s', (relativeFile) => {
    const candidate = makeCandidate()
    writeFile(
      candidate,
      relativeFile,
      `${'import { plugin } from ' + "'../"}${privateExtensionDirectory}/provider'\n`
    )
    const expected = expect.arrayContaining([
      expect.objectContaining({ file: relativeFile, rule: 'private-extension-reference' })
    ])
    expect(auditOpenCandidate(candidate)).toEqual(expected)
    expect(auditOpenWorktree(candidate, { exec: () => `${relativeFile}\0` })).toEqual(expected)
  })

  it('audits scanner fixtures without tripping its own implementation tokens', () => {
    const candidate = makeCandidate()
    writeFile(
      candidate,
      'scripts/create-open-candidate.test.js',
      "const fixture = 'provider-marker'\n"
    )
    expect(auditOpenCandidate(candidate)).toEqual([])
  })
  it('still scans private implementation content inside ordinary test files', () => {
    const candidate = makeCandidate()
    writeFile(
      candidate,
      'packages/app/src/main/neutral.test.ts',
      `const service = '${'svc' + 'Chat' + 'GPT' + 'Web'}'`
    )
    expect(auditOpenCandidate(candidate)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'packages/app/src/main/neutral.test.ts',
          rule: `${chatWebRule}-functional-reference`
        })
      ])
    )
  })

  it.each([
    'packages/app/src/shared/extensions/generatedRegistry.ts',
    'packages/app/src/main/extensions/generatedRegistry.ts',
    'packages/app/src/renderer/src/extensions/generatedRegistry.tsx',
    'packages/app/src/main/neutral.test.ts'
  ])('does not exempt private provider references in %s', (relativeFile) => {
    const candidate = makeCandidate()
    const serviceName = 'svc' + 'CodexAuth'
    const webToken = 'Chat' + 'GPT' + 'Web'
    writeFile(
      candidate,
      relativeFile,
      `export const services = ['${serviceName}', '${webToken}']\n`
    )
    const expected = expect.arrayContaining([
      expect.objectContaining({ file: relativeFile, rule: 'codex-functional-reference' }),
      expect.objectContaining({ file: relativeFile, rule: `${chatWebRule}-functional-reference` })
    ])
    expect(auditOpenCandidate(candidate)).toEqual(expected)
    expect(auditOpenWorktree(candidate, { exec: () => `${relativeFile}\0` })).toEqual(expected)
  })

  it('rejects private ChatGPT Web implementation filenames', () => {
    const candidate = makeCandidate()
    const webFile = `packages/app/src/${'chat' + 'gpt' + 'Web'}Client.ts`
    const hyphenFile = `packages/app/src/${'chat' + 'gpt' + '-web'}-session.ts`
    writeFile(candidate, webFile, 'export {}\n')
    writeFile(candidate, hyphenFile, 'export {}\n')

    expect(auditOpenCandidate(candidate)).toEqual(
      expect.arrayContaining([
        {
          file: webFile,
          line: 1,
          rule: `${chatWebRule}-filename`,
          message: 'private ChatGPT Web implementation filename'
        },
        {
          file: hyphenFile,
          line: 1,
          rule: `${chatWebRule}-filename`,
          message: 'private ChatGPT Web implementation filename'
        }
      ])
    )
  })

  it('audits both tracked and untracked public worktree files', () => {
    const source = makeCandidate()
    const trackedFile = 'packages/app/src/tracked.ts'
    const untrackedFile = `packages/app/src/${'chat' + 'gpt' + 'Web'}-untracked.ts`
    const privateToken = 'svc' + 'Chat' + 'GPT' + 'Web'
    writeFile(source, trackedFile, `const implementation = '${privateToken}'\n`)
    writeFile(source, untrackedFile, 'export {}\n')

    const calls = []
    const issues = auditOpenWorktree(source, {
      exec: (_command, args) => {
        calls.push(args)
        if (args.includes('ls-files')) return `${trackedFile}\0${untrackedFile}\0`
        throw new Error(`unexpected git command: ${args.join(' ')}`)
      }
    })

    expect(calls[0]).toEqual([
      '-C',
      source,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z'
    ])
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: trackedFile,
          rule: `${chatWebRule}-functional-reference`,
          message: privateToken
        }),
        expect.objectContaining({
          file: untrackedFile,
          rule: `${chatWebRule}-filename`
        })
      ])
    )
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

  it.each(['scripts/create-open-candidate.mjs', 'scripts/create-open-candidate.test.js'])(
    'does not exempt scanner implementation or tests: %s',
    (relativeFile) => {
      const candidate = makeCandidate()
      const token = 'svc' + 'CodexAuth'
      const fixturePath = '/' + 'private' + '/leak.txt'
      const apiToken = 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456'
      writeFile(candidate, relativeFile, [token, fixturePath, apiToken].join('\n'))
      const expected = expect.arrayContaining([
        expect.objectContaining({ file: relativeFile, rule: 'codex-functional-reference' }),
        expect.objectContaining({ file: relativeFile, rule: 'private-path-reference' }),
        expect.objectContaining({ file: relativeFile, rule: 'high-confidence-secret' })
      ])
      expect(auditOpenCandidate(candidate)).toEqual(expected)
      expect(auditOpenWorktree(candidate, { exec: () => `${relativeFile}\0` })).toEqual(expected)
    }
  )

  it.each(['LICENSE', 'src/entry.sh', 'src/data.custom'])(
    'scans extensionless and nonstandard text: %s',
    (relativeFile) => {
      const candidate = makeCandidate()
      writeFile(candidate, relativeFile, 'svc' + 'CodexAuth')
      const expected = expect.arrayContaining([
        expect.objectContaining({ file: relativeFile, rule: 'codex-functional-reference' })
      ])
      expect(auditOpenCandidate(candidate)).toEqual(expected)
      expect(auditOpenWorktree(candidate, { exec: () => `${relativeFile}\0` })).toEqual(expected)
    }
  )

  it('reports forbidden private source paths rather than silently excluding them', () => {
    const candidate = makeCandidate()
    const relativeFile = ['private', 'neutral.ts'].join('/')
    writeFile(candidate, relativeFile, 'export {}\n')
    expect(auditOpenWorktree(candidate, { exec: () => `${relativeFile}\0` })).toEqual([
      expect.objectContaining({ file: relativeFile, rule: 'forbidden-candidate-file' })
    ])
  })

  it('uses a safe-exclusion title for source submodule metadata and ComfyUI runtime entries', () => {
    const candidate = makeCandidate()
    const submoduleFile = '.gitmodules'
    const runtimeFile = 'vendor/comfyui/comfyui_data/custom_nodes/example.py'
    writeFile(candidate, submoduleFile, '[submodule "fixture"]\n\tpath = vendor/fixture\n')
    writeFile(candidate, runtimeFile, 'print("fixture runtime")\n')
    expect(
      auditOpenWorktree(candidate, {
        exec: () => `${submoduleFile}\0${runtimeFile}\0`
      })
    ).toEqual([])
  })

  it('keeps safe source exclusions out of the candidate', () => {
    const source = makeCandidate()
    const output = makeCandidate()
    const submoduleFile = '.gitmodules'
    const runtimeFile = 'vendor/comfyui/comfyui_data/custom_nodes/example.py'
    writeFile(source, submoduleFile, '[submodule "fixture"]\n\tpath = vendor/fixture\n')
    writeFile(source, runtimeFile, 'print("fixture runtime")\n')

    const result = withFakeGitLsFiles([{ path: submoduleFile }, { path: runtimeFile }], () =>
      createOpenCandidate(output, source)
    )

    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { file: submoduleFile, reason: 'submodule metadata' },
        { file: runtimeFile, reason: 'ComfyUI local runtime data' }
      ])
    )
    expect(fs.existsSync(path.join(output, submoduleFile))).toBe(false)
    expect(fs.existsSync(path.join(output, runtimeFile))).toBe(false)
  })

  it('audits ignored generated artifacts only through explicit exclusion reasons', () => {
    const source = makeCandidate()
    const generatedFiles = [
      '.aiengineelectron-dev/Data/cache.txt',
      'packages/example/target/debug/output.d',
      'config/tsconfig.tsbuildinfo',
      '.magicpot-trash-open-audit-worker.txt'
    ]
    for (const relativeFile of generatedFiles) writeFile(source, relativeFile, 'svc' + 'CodexAuth')

    const issues = auditOpenWorktree(source, {
      exec: (_command, args) => (args.includes('--ignored') ? generatedFiles.join('\0') + '\0' : '')
    })

    expect(issues).toEqual([])
    expect(getOpenCandidateExclusionReason(generatedFiles[0])).toBe('local generated artifacts')
    expect(getOpenCandidateExclusionReason(generatedFiles[1])).toBe(
      'generated dependency/build output'
    )
    expect(getOpenCandidateExclusionReason(generatedFiles[2])).toBe(
      'generated dependency/build output'
    )
    expect(getOpenCandidateExclusionReason(generatedFiles[3])).toBe('local generated artifacts')
  })

  it('audits ignored private-like sources but never copies them', () => {
    const source = makeCandidate()
    const output = makeCandidate()
    const ignoredFile = 'ignored/neutral.custom'
    writeFile(source, '.gitignore', 'ignored/\n')
    writeFile(source, ignoredFile, 'svc' + 'CodexAuth')
    const calls = []
    const issues = auditOpenWorktree(source, {
      exec: (_command, args) => {
        calls.push(args)
        if (args.includes('--ignored')) return `${ignoredFile}\0`
        return ''
      }
    })
    expect(issues).toEqual([
      expect.objectContaining({ file: ignoredFile, rule: 'codex-functional-reference' })
    ])
    expect(calls.some((args) => args.includes('--ignored'))).toBe(true)
    withFakeGitLsFiles([], () => createOpenCandidate(output, source))
    expect(fs.existsSync(path.join(output, ignoredFile))).toBe(false)
  })

  it('does not trust ambient fake Git enumeration or redirected Git variables', () => {
    const candidate = makeCandidate()
    const fakeList = path.join(makeCandidate(), 'empty-list')
    fs.writeFileSync(fakeList, '')
    vi.stubEnv('MAGICPOT_FAKE_GIT_LS_FILES', fakeList)
    vi.stubEnv('GIT_INDEX_FILE', path.join(candidate, 'unrelated-index'))
    vi.stubEnv('GIT_DIR', path.join(candidate, 'other-repo'))
    expect(hasGitRepository(candidate)).toBe(false)
    const options = vi.mocked(execFileSync).mock.calls[0]?.[2]
    expect(options?.env).toBeDefined()
    expect(options?.env?.GIT_INDEX_FILE).toBeUndefined()
    expect(options?.env?.GIT_DIR).toBeUndefined()
  })

  it('rejects trash root and linked output directories without changing their targets', () => {
    expect(() => resolveTrashCandidatePath(trashRoot)).toThrow()
    const owned = makeCandidate()
    const outside = makeCandidate()
    writeFile(outside, 'sentinel', 'unchanged')
    const link = path.join(owned, 'linked-output')
    fs.symlinkSync(outside, link, 'junction')
    expect(() => resolveTrashCandidatePath(link)).toThrow(/link|junction/i)
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('unchanged')
  })

  it('rejects linked candidate and worktree entries rather than following them', () => {
    const candidate = makeCandidate()
    const outside = makeCandidate()
    writeFile(outside, 'leak.ts', 'svc' + 'CodexAuth')
    fs.symlinkSync(outside, path.join(candidate, 'linked'), 'junction')
    expect(auditOpenCandidate(candidate)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'linked', rule: 'unsafe-file-entry' })
      ])
    )
    expect(auditOpenWorktree(candidate, { exec: () => 'linked/leak.ts\0' })).toEqual([
      expect.objectContaining({ file: 'linked/leak.ts', rule: 'unsafe-file-entry' })
    ])
  })

  it.each(['create', 'verify'])('audits untracked source before %s writes a candidate', (mode) => {
    const source = makeCandidate()
    const output = makeCandidate()
    writeFile(output, 'sentinel', 'unchanged')
    const relativeFile = 'src/untracked.test.ts'
    writeFile(source, relativeFile, 'svc' + 'CodexAuth')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    withFakeGitLsFiles([{ path: relativeFile }], () => {
      const realMock = vi.mocked(execFileSync).getMockImplementation()
      vi.mocked(execFileSync).mockImplementation((command, args, options) =>
        args.includes('--stage') ? '' : realMock(command, args, options)
      )
      expect(() =>
        mode === 'create'
          ? createOpenCandidate(output, source)
          : runVerifyMode({ sourceRoot: source })
      ).toThrow(/worktree audit failed/i)
    })
    expect(fs.readFileSync(path.join(output, 'sentinel'), 'utf8')).toBe('unchanged')
  })

  it('audits untracked source before create writes a candidate and cleans partial output on copy failure', () => {
    const source = makeCandidate()
    const output = makeCandidate()
    const relativeFile = 'src/safe.ts'
    writeFile(source, relativeFile, 'export const safe = true\n')
    const copySpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('copy failed')
    })

    withFakeGitLsFiles([{ path: relativeFile }], () => {
      expect(() => createOpenCandidate(output, source)).toThrow('copy failed')
    })

    expect(copySpy).toHaveBeenCalled()
    expect(fs.existsSync(output)).toBe(false)
  })

  it('fails closed when a source file is modified during copy', () => {
    const source = makeCandidate()
    const output = makeCandidate()
    const relativeFile = 'src/safe.ts'
    writeFile(source, relativeFile, 'export const safe = true\n')
    const originalWriteFileSync = fs.writeFileSync.bind(fs)
    let writes = 0
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, ...rest) => {
      writes += 1
      if (writes === 1) {
        originalWriteFileSync(path.join(source, relativeFile), Buffer.from('x'.repeat(data.length)))
      }
      return originalWriteFileSync(file, data, ...rest)
    })
    withFakeGitLsFiles([{ path: relativeFile }], () => {
      expect(() => createOpenCandidate(output, source)).toThrow(
        'source changed during candidate creation'
      )
    })
    expect(writeSpy).toHaveBeenCalled()
    expect(fs.existsSync(output)).toBe(false)
  })

  it('fails closed when a source file is added after snapshot enumeration', () => {
    const source = makeCandidate()
    const output = makeCandidate()
    const relativeFile = 'src/safe.ts'
    writeFile(source, relativeFile, 'export const safe = true\n')
    withFakeGitLsFiles([{ path: relativeFile }], () => {
      const mock = vi.mocked(execFileSync)
      const previous = mock.getMockImplementation()
      mock.mockImplementation((command, args, options) => {
        if (!args.includes('ls-files')) return previous(command, args, options)
        const paths = fs.existsSync(path.join(source, 'src/added.ts'))
          ? [relativeFile, 'src/added.ts']
          : [relativeFile]
        return args.includes('--stage')
          ? paths
              .map((file) => `100644 0000000000000000000000000000000000000000 0\t${file}\0`)
              .join('')
          : paths.map((file) => `${file}\0`).join('')
      })
      const originalWriteFileSync = fs.writeFileSync.bind(fs)
      let writes = 0
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, ...rest) => {
        writes += 1
        if (writes === 1)
          originalWriteFileSync(path.join(source, 'src/added.ts'), 'export const added = true\n')
        return originalWriteFileSync(file, data, ...rest)
      })
      try {
        expect(() => createOpenCandidate(output, source)).toThrow(
          'source changed during candidate creation'
        )
      } finally {
        writeSpy.mockRestore()
        mock.mockImplementation(previous)
      }
    })
    expect(fs.existsSync(output)).toBe(false)
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
      [{ path: 'README.md' }, { path: 'packages/app/src/index.ts' }],
      () => createOpenCandidate(output, source)
    )

    expect(result.candidatePath).toBe(output)
    expect(fs.existsSync(path.join(output, 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(output, 'packages/app/src/index.ts'))).toBe(true)
    expect(fs.existsSync(path.join(output, '.npmrc'))).toBe(false)
    expect(fs.existsSync(path.join(output, blockedPath))).toBe(false)
    expect(result.skipped).toEqual([])
  })
})
