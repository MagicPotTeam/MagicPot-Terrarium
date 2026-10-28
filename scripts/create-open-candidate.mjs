import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const possiblePrivateRepoRoot = path.resolve(repoRoot, '..', '..')
const workspaceRoot =
  path.basename(path.dirname(repoRoot)) === 'open' &&
  fs.existsSync(path.join(possiblePrivateRepoRoot, 'private', 'codex'))
    ? possiblePrivateRepoRoot
    : repoRoot
const trashRoot = path.join(workspaceRoot, '.magicpot-trash')
const defaultCandidatePath = path.join(trashRoot, 'MagicPot-Terrarium-candidate')
const textExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.pem',
  '.py',
  '.sh',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
])
const snapshotMaxBytes = 512 * 1024 * 1024

const parseArgs = (argv) => {
  const options = new Map()
  const flags = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const [name, inlineValue] = arg.split('=', 2)
    if (inlineValue !== undefined) {
      options.set(name, inlineValue)
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      options.set(name, next)
      index += 1
      continue
    }
    flags.add(name)
  }
  return {
    verify: flags.has('--verify'),
    auditOnly: flags.has('--audit-current'),
    output: path.resolve(options.get('--output') ?? defaultCandidatePath),
    source: path.resolve(options.get('--source') ?? repoRoot),
    target: path.resolve(options.get('--target') ?? repoRoot),
    keepVerifyCandidate: flags.has('--keep-verify-candidate')
  }
}

const toPosix = (file) => file.replace(/\\/g, '/')
const cleanGitEnv = () => {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

const findSymlinkInPath = (root, relativeFile = '') => {
  let current = path.resolve(root)
  try {
    if (fs.lstatSync(current).isSymbolicLink()) return current
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return null
  }
  for (const segment of toPosix(relativeFile).split('/').filter(Boolean)) {
    current = path.join(current, segment)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return current
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  return null
}

const ensureInsideTrash = (targetPath, { allowRoot = false } = {}) => {
  const resolvedTrash = path.resolve(trashRoot)
  const resolvedTarget = path.resolve(targetPath)
  const relative = path.relative(resolvedTrash, resolvedTarget)
  if (
    (!allowRoot && resolvedTarget === resolvedTrash) ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing to write outside trash root: ${resolvedTarget}`)
  }
  const symlink = findSymlinkInPath(resolvedTrash, relative)
  if (symlink) throw new Error(`Trash path must not traverse a symlink or junction: ${symlink}`)
}
const removeDirectory = (dir) => {
  ensureInsideTrash(dir)
  fs.rmSync(dir, { recursive: true, force: true })
}
export const resolveTrashCandidatePath = (candidatePath) => {
  const resolved = path.resolve(candidatePath)
  ensureInsideTrash(resolved)
  return resolved
}
const execGit = (args, options = {}) =>
  execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024, ...options, env: cleanGitEnv() })
export const hasGitRepository = (dir = repoRoot) => {
  try {
    const topLevel = execGit(['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return path.resolve(topLevel.trim()) === path.resolve(dir)
  } catch {
    return false
  }
}

const readTrackedFiles = (sourceRoot = repoRoot) =>
  execGit(['ls-files', '--stage', '-z'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [meta, file] = record.split('\t')
      const [mode] = meta.split(' ')
      return { mode, file: toPosix(file) }
    })
const readTrackedAndUntrackedFiles = (sourceRoot, exec = execFileSync) => {
  const output = exec(
    'git',
    ['-C', sourceRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      encoding: 'utf8',
      env: cleanGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024
    }
  )
  return output.split('\0').filter(Boolean).map(toPosix)
}
const ignoredAuditPathspecs = [
  ':(exclude).aiengineelectron-dev/**',
  ':(exclude).magicpot-trash/**',
  ':(exclude).codex/**',
  ':(exclude).codex-tmp/**',
  ':(exclude)node_modules/**',
  ':(exclude)out/**',
  ':(exclude)dist/**',
  ':(exclude)target/**',
  ':(exclude)vendor/comfyui/**'
]
const readIgnoredUntrackedFiles = (sourceRoot, exec = execFileSync) => {
  const output = exec(
    'git',
    [
      '-C',
      sourceRoot,
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
      '--',
      ...ignoredAuditPathspecs
    ],
    {
      encoding: 'utf8',
      env: cleanGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024
    }
  )
  return output.split('\0').filter(Boolean).map(toPosix)
}

const basenameLower = (file) => path.posix.basename(file).toLowerCase()
const isEnvFile = (name) => name === '.env' || name.startsWith('.env.') || name.startsWith('.env-')
const isAllowedEnvExample = (name) => name === '.env.example' || name === '.env.sample'
const privatePathSegment = 'private'
const privateExtSegment = privatePathSegment + 'Extensions'
const codexSegment = 'codex'
const chatWebMixedSegment = 'chat' + 'gpt' + 'Web'
const chatWebLowerSegment = chatWebMixedSegment.toLowerCase()
const scannerPrivateFixtureDirectoryToken = privatePathSegment
const privateSourcePathPrefixes = [
  ['packages', 'app', 'src', 'main', privateExtSegment],
  ['packages', 'app', 'src', 'renderer', 'src', privateExtSegment],
  ['packages', 'app', 'src', 'shared', privateExtSegment],
  ['packages', 'app', 'src', 'main', 'extensions', privateExtSegment],
  ['packages', 'app', 'src', 'main', 'llmProxy', privateExtSegment]
].map((segments) => segments.join('/').toLowerCase())
const privateSourcePathExact = new Set(
  [
    ['packages', 'app', 'src', 'main', 'api', codexSegment + 'ChatClient.ts'],
    ['packages', 'app', 'src', 'main', 'api', codexSegment + 'RequestGovernor.ts'],
    ['packages', 'app', 'src', 'main', 'llmProxy', codexSegment + 'AttachmentArtifacts.ts'],
    ['packages', 'app', 'src', 'main', 'api', codexSegment + 'ModelDiscovery.ts'],
    ['packages', 'app', 'src', 'main', 'api', codexSegment + 'OAuth.ts'],
    ['packages', 'app', 'src', 'main', 'api', 'svc' + 'CodexAuthImpl.ts'],
    ['packages', 'app', 'src', 'main', 'api', 'svc' + 'CodexModelsImpl.ts'],
    ['packages', 'app', 'src', 'main', 'api', 'svc' + chatWebMixedSegment + 'Impl.ts'],
    ['packages', 'app', 'src', 'main', 'llmProxy', chatWebLowerSegment + 'Client.ts'],
    ['packages', 'app', 'src', 'main', 'llmProxy', chatWebLowerSegment + 'Dom.ts'],
    ['packages', 'app', 'src', 'main', 'llmProxy', chatWebLowerSegment + 'LlmProxyExtension.ts'],
    ['packages', 'app', 'src', 'main', 'llmProxy', chatWebLowerSegment + 'SessionManager.ts'],
    ['packages', 'app', 'src', 'shared', 'api', 'svc' + 'CodexAuth.ts'],
    ['packages', 'app', 'src', 'shared', 'api', 'svc' + 'CodexModels.ts'],
    ['packages', 'app', 'src', 'shared', 'api', 'svc' + chatWebMixedSegment + '.ts'],
    ['packages', 'app', 'src', 'shared', 'llm', 'profileHelpers.ts'],
    ['packages', 'app', 'src', 'shared', 'llm', 'profileHelpers.test.ts'],
    [
      'packages',
      'app',
      'src',
      'renderer',
      'src',
      'pages',
      'SettingsPage',
      chatWebMixedSegment + 'Settings.tsx'
    ],
    [
      'packages',
      'app',
      'src',
      'renderer',
      'src',
      'pages',
      'SettingsPage',
      chatWebMixedSegment + 'Translations.ts'
    ],
    ['packages', 'app', 'src', 'shared', 'locales', 'en-US', chatWebLowerSegment + '.json'],
    ['packages', 'app', 'src', 'shared', 'locales', 'zh-CN', chatWebLowerSegment + '.json'],
    ['packages', 'app', 'src', 'shared', 'locales', 'en-US', codexSegment + '.json'],
    ['packages', 'app', 'src', 'shared', 'locales', 'zh-CN', codexSegment + '.json']
  ].map((segments) => segments.join('/').toLowerCase())
)
const isDeclaredPrivateSourcePath = (file) => {
  const normalized = toPosix(file).toLowerCase()
  return (
    privateSourcePathExact.has(normalized) ||
    privateSourcePathPrefixes.some(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
    )
  )
}
export const getOpenCandidatePrivateSourcePathReason = (file) =>
  isDeclaredPrivateSourcePath(file) ? 'declared private source implementation' : null

export const getOpenCandidateExclusionReason = (file, mode = '100644') => {
  const normalized = toPosix(file),
    lower = normalized.toLowerCase(),
    name = basenameLower(normalized)
  if (mode === '160000') return 'git submodule/link'
  if (mode === '120000') return 'git symlink/link'
  if (lower === '.git' || lower.includes('/.git/')) return 'git metadata'
  if (lower === '.magicpot-trash' || lower.startsWith('.magicpot-trash/'))
    return 'local generated artifacts'
  if (lower === '.aiengineelectron-dev' || lower.startsWith('.aiengineelectron-dev/'))
    return 'local generated artifacts'
  if (
    lower === 'target' ||
    lower.startsWith('target/') ||
    lower.includes('/target/') ||
    name.endsWith('.tsbuildinfo')
  )
    return 'generated dependency/build output'
  if (name === '.magicpot-trash-open-audit-worker.txt') return 'local generated artifacts'
  if (normalized === '.gitmodules') return 'submodule metadata'
  if (name === '.npmrc') return 'npm auth/config file'
  if (name === '.eslintcache') return 'generated dependency/build output'
  if (isEnvFile(name) && !isAllowedEnvExample(name)) return '.env policy'
  if (name === 'auth.json' || name === 'cookies.txt') return 'local auth material'
  if (name === 'vc_redist.x64.exe') return 'Microsoft VC Redistributable licensing blocker'
  if (isDeclaredPrivateSourcePath(normalized)) return 'declared private source implementation'
  if (
    lower.startsWith('.codex/') ||
    lower.startsWith('.codex-tmp/') ||
    lower.includes('/.codex/') ||
    lower.includes('/.codex-tmp/')
  )
    return 'Codex local state'
  if (
    lower === 'node_modules' ||
    lower === 'dist' ||
    lower === 'out' ||
    lower.startsWith('node_modules/') ||
    lower.startsWith('dist/') ||
    lower.startsWith('out/') ||
    lower.includes('/node_modules/') ||
    lower.includes('/dist/') ||
    lower.includes('/out/')
  )
    return 'generated dependency/build output'
  if (
    lower === scannerPrivateFixtureDirectoryToken ||
    lower.startsWith(`${scannerPrivateFixtureDirectoryToken}/`)
  )
    return 'open/private workspace wrapper'
  if (lower === 'vendor/comfyui' || lower.startsWith('vendor/comfyui/'))
    return 'ComfyUI local runtime data'
  return null
}

const chatWebToken = 'chat' + 'gpt' + 'web'
const chatWebHyphenToken = 'chat' + 'gpt' + '-web'
const chatWebSnakeToken = 'chat' + 'gpt' + '_web'
const serviceChatWebToken = 'svc' + chatWebToken
const chatWebRulePrefix = 'chat' + 'gpt' + '-web'
const scannerPrivateExtensionToken = privatePathSegment + 'Ext' + 'ensions'
const privateExtensionRuleName = 'private' + '-extension-reference'
const privateWebFilenamePattern = new RegExp(
  [chatWebToken, chatWebHyphenToken, chatWebSnakeToken, serviceChatWebToken].join('|'),
  'i'
)
export const getOpenCandidatePrivacyFileReason = (file) => {
  const normalized = toPosix(file)
  const filenameReason = normalized.split('/').some((part) => {
    privateWebFilenamePattern.lastIndex = 0
    return privateWebFilenamePattern.test(part)
  })
  return filenameReason ? 'private ChatGPT Web implementation filename' : null
}
const getSourceFiles = (sourceRoot) =>
  [
    ...new Set([
      ...readTrackedFiles(sourceRoot).map(({ file }) => file),
      ...readTrackedAndUntrackedFiles(sourceRoot)
    ])
  ].sort()
const getAuditFiles = (sourceRoot, exec = execFileSync) =>
  [
    ...new Set([
      ...readTrackedAndUntrackedFiles(sourceRoot, exec),
      ...readIgnoredUntrackedFiles(sourceRoot, exec)
    ])
  ].sort()
const getLineNumber = (text, index) => text.slice(0, index).split(/\r?\n/).length
const readTextContent = (file) => {
  const bytes = fs.readFileSync(file)
  if (!textExtensions.has(path.extname(file).toLowerCase()) && bytes.includes(0)) return null
  return bytes.toString('utf8')
}

const addContentIssues = ({ relativeFile, text, issues }) => {
  const codexFunctionalPattern = new RegExp(
    [
      'codex' + 'OAuth',
      'codex' + 'ChatClient',
      'svc' + 'Codex[A-Za-z0-9_]*',
      'Codex' + 'ChatGPTCli',
      'backend-api/' + 'codex'
    ].join('|'),
    'gi'
  )
  const privateWebFunctionalPattern = new RegExp(
    [chatWebToken, chatWebHyphenToken, chatWebSnakeToken, serviceChatWebToken].join('|'),
    'gi'
  )
  const privateWebOriginIdentifiers = [
    'chat' + 'gpt' + '_ORIGIN',
    'chat' + 'gpt' + '_PAGE_ORIGINS',
    'chat' + 'gpt' + '_AUTH_ORIGINS',
    'chat' + 'gpt' + '_ALLOWED_ORIGINS',
    'validate' + 'ChatGPT' + 'SessionUrl',
    'is' + 'ChatGPT' + 'PageUrl',
    'is' + 'Allowed' + 'ChatGPT' + 'Url'
  ]
  const privateWebSessionIdentifiers = [
    'load' + 'ChatGPT' + 'Page',
    'ChatGPT' + 'Web' + 'Session',
    'validate' + 'ChatGPT' + 'Session'
  ]
  const chatWebHosts = [
    'chat' + 'gpt' + '[.]com',
    'chat' + '[.]openai' + '[.]com',
    'auth' + '[.]openai' + '[.]com'
  ]
  const privateWebOriginPattern = new RegExp(
    `(?<![A-Za-z0-9])(?:https?:\\/\\/)?(?:www\\.)?(?:${chatWebHosts.join('|')})(?=[/:?#\\s"'\\x60)]|$)|\\b(?:${privateWebOriginIdentifiers.join('|')})\\b`,
    'gi'
  )
  const privateWebSessionPattern = new RegExp(
    [
      `(?:${chatWebToken}|${chatWebHyphenToken}|${chatWebSnakeToken}).{0,80}(?:session|origin|partition)`,
      `(?:session|origin|partition).{0,80}(?:${chatWebToken}|${chatWebHyphenToken}|${chatWebSnakeToken})`,
      `\\b(?:${privateWebSessionIdentifiers.join('|')})\\b`,
      '\\bSESSION_?PARTITION\\b',
      `\\bsession\\s*[:=]\\s*["'\\x60]?persist:[^\\s"'\\x60]*`,
      `\\bpartition\\s*[:=]\\s*["'\\x60]?persist:[^\\s"'\\x60]*`,
      `\\bpersist:[^\\s"'\\x60]*${chatWebToken}[^\\s"'\\x60]*`
    ].join('|'),
    'gi'
  )
  const privateWebDomBridgePattern = new RegExp(
    ['__magicpot' + chatWebToken, 'chat' + 'gpt' + '_WEB_DOM_BRIDGE'].join('|'),
    'gi'
  )
  const privateExtensionReferencePattern = new RegExp(
    `(?:${scannerPrivateExtensionToken}|from\\s+['"][^'"]*${scannerPrivateExtensionToken})`,
    'gi'
  )
  const scannerPrivatePathTokens = ['private', 'internal', 'premium', 'open-private']
  const privatePathAlternation = scannerPrivatePathTokens
    .map((token) => (token === 'private' ? 'private(?![-A-Za-z0-9_])' : token))
    .join('|')
  const privatePathPattern = new RegExp(
    String.raw`(?:[A-Za-z]:[\\/][^\r\n"'\x60]*[\\/](?:${privatePathAlternation})[\\/][^\r\n"'\x60]*|(?:(?:^|[\\/"'\x60\s])(?:${privatePathAlternation})[\\/][^\r\n"'\x60\s)]+))`,
    'gi'
  )
  const highConfidenceSecretPattern =
    /(?:sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9_]{36,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN ((?:RSA |OPENSSH |EC |DSA )?)PRIVATE KEY-----[A-Za-z0-9+/=\r\n]{32,8192}-----END \1PRIVATE KEY-----)/g
  const rules = [
    { rule: 'codex-functional-reference', pattern: codexFunctionalPattern },
    { rule: privateExtensionRuleName, pattern: privateExtensionReferencePattern },
    { rule: `${chatWebRulePrefix}-functional-reference`, pattern: privateWebFunctionalPattern },
    { rule: `${chatWebRulePrefix}-origin-reference`, pattern: privateWebOriginPattern },
    { rule: `${chatWebRulePrefix}-session-reference`, pattern: privateWebSessionPattern },
    { rule: `${chatWebRulePrefix}-dom-bridge-reference`, pattern: privateWebDomBridgePattern },
    { rule: 'private-path-reference', pattern: privatePathPattern },
    { rule: 'high-confidence-secret', pattern: highConfidenceSecretPattern }
  ]
  for (const { rule, pattern } of rules) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(text))) {
      issues.push({
        file: relativeFile,
        line: getLineNumber(text, match.index),
        rule,
        message: match[0].slice(0, 160)
      })
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1
    }
  }
}

const addFileIssues = (root, relativeFile, issues, { reportForbiddenFiles = false } = {}) => {
  const normalizedFile = toPosix(relativeFile)
  const symlink = findSymlinkInPath(root, normalizedFile)
  if (symlink) {
    issues.push({
      file: normalizedFile,
      line: 1,
      rule: 'unsafe-file-entry',
      message: `symlink or junction: ${normalizedFile}`
    })
    return
  }
  const reason = getOpenCandidateExclusionReason(normalizedFile)
  if (reason) {
    if (reportForbiddenFiles)
      issues.push({
        file: normalizedFile,
        line: 1,
        rule: 'forbidden-candidate-file',
        message: reason
      })
    return
  }
  const privacyReason = getOpenCandidatePrivacyFileReason(normalizedFile)
  if (privacyReason) {
    issues.push({
      file: normalizedFile,
      line: 1,
      rule: `${chatWebRulePrefix}-filename`,
      message: privacyReason
    })
    return
  }
  const file = path.join(root, normalizedFile)
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch {
    return
  }
  if (!stat.isFile()) return
  const text = readTextContent(file)
  if (text !== null) addContentIssues({ relativeFile: normalizedFile, text, issues })
}

const sourceChangedError = (relativeFile) =>
  new Error(
    relativeFile
      ? `source changed during candidate creation: ${relativeFile}`
      : 'source changed during candidate creation'
  )
const getFileFingerprint = (stat) => ({
  mode: stat.mode,
  size: stat.size,
  mtimeNs: stat.mtimeNs?.toString() ?? `${stat.mtimeMs}`,
  dev: stat.dev,
  ino: stat.ino
})
const fingerprintsEqual = (left, right) =>
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.dev === right.dev &&
  left.ino === right.ino
const hashBytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const readStableSourceBytes = (sourceRoot, relativeFile) => {
  const source = path.join(sourceRoot, relativeFile)
  if (findSymlinkInPath(sourceRoot, relativeFile)) throw sourceChangedError(relativeFile)
  let before
  try {
    before = fs.lstatSync(source)
  } catch {
    throw sourceChangedError(relativeFile)
  }
  if (!before.isFile() || before.isSymbolicLink()) throw sourceChangedError(relativeFile)
  const bytes = fs.readFileSync(source)
  let after
  try {
    after = fs.lstatSync(source)
  } catch {
    throw sourceChangedError(relativeFile)
  }
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    !fingerprintsEqual(getFileFingerprint(before), getFileFingerprint(after))
  )
    throw sourceChangedError(relativeFile)
  return { bytes, fingerprint: getFileFingerprint(after), hash: hashBytes(bytes) }
}
const getSnapshotFileSet = (sourceRoot) => [...new Set(getSourceFiles(sourceRoot))].sort()
const getCopyableSourceFiles = (sourceRoot) =>
  getSnapshotFileSet(sourceRoot).filter((file) => !getOpenCandidateExclusionReason(file))
const createSourceSnapshot = (sourceRoot) => {
  const allFiles = getSnapshotFileSet(sourceRoot),
    files = getCopyableSourceFiles(sourceRoot),
    entries = new Map()
  let totalBytes = 0
  for (const file of files) {
    const entry = readStableSourceBytes(sourceRoot, file)
    totalBytes += entry.bytes.length
    if (totalBytes > snapshotMaxBytes) throw new Error('source snapshot exceeds memory limit')
    entries.set(file, entry)
  }
  if (files.join('\0') !== getCopyableSourceFiles(sourceRoot).join('\0'))
    throw sourceChangedError('<file-set>')
  return { allFiles, files, entries }
}
const assertSourceSnapshotCurrent = (sourceRoot, snapshot) => {
  if (getCopyableSourceFiles(sourceRoot).join('\0') !== snapshot.files.join('\0'))
    throw sourceChangedError('<file-set>')
  for (const [file, expected] of snapshot.entries) {
    const actual = readStableSourceBytes(sourceRoot, file)
    if (
      actual.hash !== expected.hash ||
      !fingerprintsEqual(actual.fingerprint, expected.fingerprint)
    )
      throw sourceChangedError(file)
  }
}
const copyTrackedFiles = (candidatePath, sourceRoot = repoRoot, snapshot) => {
  if (!snapshot) throw new Error('source snapshot required')
  const skipped = [],
    sourceFiles = snapshot.allFiles
  let copied = 0
  assertSourceSnapshotCurrent(sourceRoot, snapshot)
  removeDirectory(candidatePath)
  fs.mkdirSync(candidatePath, { recursive: true })
  for (const file of sourceFiles) {
    const reason = getOpenCandidateExclusionReason(file)
    if (reason) {
      skipped.push({ file, reason })
      continue
    }
    const entry = snapshot.entries.get(file)
    if (!entry) throw sourceChangedError(file)
    const destination = path.join(candidatePath, file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, entry.bytes)
    fs.chmodSync(destination, entry.fingerprint.mode & 0o777)
    copied += 1
  }
  assertSourceSnapshotCurrent(sourceRoot, snapshot)
  return { copied, skipped }
}

const collectCandidateFiles = (dir, candidatePath, files = [], issues = []) => {
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(dir, entry.name),
      relativeEntry = toPosix(path.relative(candidatePath, fullPath))
    if (entry.isSymbolicLink()) {
      issues.push({
        file: relativeEntry,
        line: 1,
        rule: 'unsafe-file-entry',
        message: `symlink or junction: ${relativeEntry}`
      })
      continue
    }
    const reason = getOpenCandidateExclusionReason(relativeEntry)
    if (reason) {
      issues.push({
        file: relativeEntry,
        line: 1,
        rule: 'forbidden-candidate-file',
        message: reason
      })
      continue
    }
    const privacyReason = getOpenCandidatePrivacyFileReason(relativeEntry)
    if (privacyReason) {
      issues.push({
        file: relativeEntry,
        line: 1,
        rule: `${chatWebRulePrefix}-filename`,
        message: privacyReason
      })
      continue
    }
    if (entry.isDirectory()) collectCandidateFiles(fullPath, candidatePath, files, issues)
    else files.push(fullPath)
  }
  return files
}
export const auditOpenCandidate = (candidatePath) => {
  ensureInsideTrash(candidatePath)
  const issues = [],
    files = collectCandidateFiles(candidatePath, candidatePath, [], issues)
  for (const file of files)
    addFileIssues(candidatePath, toPosix(path.relative(candidatePath, file)), issues, {
      reportForbiddenFiles: true
    })
  return issues
}
const isBenignWorktreeExclusion = (relativeFile) =>
  [
    'submodule metadata',
    'ComfyUI local runtime data',
    'local generated artifacts',
    'generated dependency/build output',
    'Codex local state',
    'git metadata'
  ].includes(getOpenCandidateExclusionReason(relativeFile))
export const auditOpenWorktree = (sourceRoot = repoRoot, { exec = execFileSync } = {}) => {
  const issues = []
  for (const relativeFile of getAuditFiles(sourceRoot, exec)) {
    const exclusionReason = getOpenCandidateExclusionReason(relativeFile)
    if (exclusionReason && isBenignWorktreeExclusion(relativeFile)) continue
    addFileIssues(sourceRoot, relativeFile, issues, {
      reportForbiddenFiles: Boolean(exclusionReason)
    })
  }
  return issues
}
const formatIssues = (label, issues) => {
  console.error(`${label} failed: ${issues.length} issue(s).`)
  for (const issue of issues.slice(0, 200))
    console.error(`${issue.file}:${issue.line} [${issue.rule}] ${issue.message}`)
  if (issues.length > 200) console.error(`... ${issues.length - 200} more issue(s) omitted.`)
}
const verifySnapshotContent = (snapshot) => {
  const issues = []
  for (const [relativeFile, entry] of snapshot.entries) {
    const extension = path.extname(relativeFile).toLowerCase()
    if (!textExtensions.has(extension) && entry.bytes.includes(0)) continue
    addContentIssues({ relativeFile, text: entry.bytes.toString('utf8'), issues })
  }
  if (issues.length > 0) {
    formatIssues('Open worktree audit', issues)
    const error = new Error('Open worktree audit failed')
    error.exitCode = 1
    throw error
  }
}
const verifyCandidate = (candidatePath) => {
  const issues = auditOpenCandidate(candidatePath)
  if (issues.length > 0) {
    formatIssues('Open candidate audit', issues)
    const error = new Error('Open candidate audit failed')
    error.exitCode = 1
    throw error
  }
  console.log('Open candidate audit passed.')
}
const verifyWorktree = (sourceRoot) => {
  const issues = auditOpenWorktree(sourceRoot)
  if (issues.length > 0) {
    formatIssues('Open worktree audit', issues)
    const error = new Error('Open worktree audit failed')
    error.exitCode = 1
    throw error
  }
  console.log('Open worktree audit passed.')
}
export const createOpenCandidate = (
  candidatePath = defaultCandidatePath,
  sourceRoot = repoRoot
) => {
  const sourceSnapshot = hasGitRepository(sourceRoot)
    ? (() => {
        verifyWorktree(sourceRoot)
        const snapshot = createSourceSnapshot(sourceRoot)
        verifySnapshotContent(snapshot)
        return snapshot
      })()
    : null
  const resolvedCandidatePath = resolveTrashCandidatePath(candidatePath)
  fs.mkdirSync(trashRoot, { recursive: true })
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  try {
    const { copied, skipped } = copyTrackedFiles(resolvedCandidatePath, sourceRoot, sourceSnapshot)
    console.log(`Open candidate run id: ${runId}`)
    console.log(`Open candidate source: ${sourceRoot}`)
    console.log(`Open candidate path: ${candidatePath}`)
    console.log(`Copied files: ${copied}`)
    console.log(`Skipped files: ${skipped.length}`)
    verifyCandidate(resolvedCandidatePath)
    return { runId, candidatePath: resolvedCandidatePath, copied, skipped }
  } catch (error) {
    removeDirectory(resolvedCandidatePath)
    throw error
  }
}
export const runVerifyMode = ({ keepVerifyCandidate = false, sourceRoot = repoRoot } = {}) => {
  if (!hasGitRepository(sourceRoot)) {
    verifyCandidate(sourceRoot)
    console.log(`Verified current candidate: ${sourceRoot}`)
    return { candidatePath: sourceRoot, auditCurrent: true }
  }
  verifyWorktree(sourceRoot)
  const sourceSnapshot = createSourceSnapshot(sourceRoot)
  verifySnapshotContent(sourceSnapshot)
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const verifyCandidatePath = path.join(trashRoot, `MagicPot-Terrarium-candidate-check-${runId}`)
  ensureInsideTrash(verifyCandidatePath)
  try {
    copyTrackedFiles(verifyCandidatePath, sourceRoot, sourceSnapshot)
    verifyCandidate(verifyCandidatePath)
    console.log(`Verified source: ${sourceRoot}`)
    console.log(`Verified temporary candidate: ${verifyCandidatePath}`)
    return { candidatePath: verifyCandidatePath, auditCurrent: false }
  } finally {
    if (!keepVerifyCandidate) removeDirectory(verifyCandidatePath)
  }
}
export const main = (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv)
  if (options.auditOnly) {
    verifyWorktree(options.target)
    return
  }
  if (options.verify) {
    runVerifyMode({ keepVerifyCandidate: options.keepVerifyCandidate, sourceRoot: options.source })
    return
  }
  createOpenCandidate(options.output, options.source)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    if (error?.exitCode) process.exit(error.exitCode)
    throw error
  }
}
