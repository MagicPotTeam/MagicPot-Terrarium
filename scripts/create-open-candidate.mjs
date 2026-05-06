import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const possiblePrivateRepoRoot = path.resolve(repoRoot, '..', '..')
const workspaceRoot =
  path.basename(path.dirname(repoRoot)) === 'open' &&
  fs.existsSync(path.join(possiblePrivateRepoRoot, 'private', 'codex'))
    ? possiblePrivateRepoRoot
    : repoRoot
const trashRoot = path.join(workspaceRoot, '.magicpot-trash')
const defaultCandidatePath = path.join(trashRoot, 'magicpot-open-candidate')
const textExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
])

const parseArgs = (argv) => {
  const options = new Map()
  const flags = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      continue
    }
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

const ensureInsideTrash = (targetPath) => {
  const resolvedTrash = path.resolve(trashRoot)
  const resolvedTarget = path.resolve(targetPath)
  const relative = path.relative(resolvedTrash, resolvedTarget)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside trash root: ${resolvedTarget}`)
  }
}

const removeDirectory = (dir) => {
  ensureInsideTrash(dir)
  fs.rmSync(dir, { recursive: true, force: true })
}

export const hasGitRepository = (dir = repoRoot) => {
  try {
    execGit(['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return true
  } catch {
    return false
  }
}

const execGit = (args, options) => {
  const fakeGitLsFilesPath = process.env.MAGICPOT_FAKE_GIT_LS_FILES
  if (fakeGitLsFilesPath) {
    if (args[0] === 'rev-parse') {
      return 'true\n'
    }
    if (args[0] === 'ls-files') {
      return fs.readFileSync(fakeGitLsFilesPath, options.encoding ?? undefined)
    }
  }
  return execFileSync('git', args, options)
}

const readTrackedFiles = (sourceRoot = repoRoot) => {
  const output = execGit(['ls-files', '--stage', '-z'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32
  })
  return output
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [meta, file] = record.split('\t')
      const [mode] = meta.split(' ')
      return { mode, file: toPosix(file) }
    })
}

const basenameLower = (file) => path.posix.basename(file).toLowerCase()

const isEnvFile = (name) => name === '.env' || name.startsWith('.env.') || name.startsWith('.env-')

const isAllowedEnvExample = (name) => name === '.env.example' || name === '.env.sample'

export const getOpenCandidateExclusionReason = (file, mode = '100644') => {
  const normalized = toPosix(file)
  const lower = normalized.toLowerCase()
  const name = basenameLower(normalized)

  if (mode === '160000') {
    return 'git submodule/link'
  }
  if (lower === '.git' || lower.includes('/.git/')) {
    return 'git metadata'
  }
  if (lower === '.magicpot-trash' || lower.startsWith('.magicpot-trash/')) {
    return 'local generated artifacts'
  }
  if (normalized === '.gitmodules') {
    return 'submodule metadata'
  }
  if (name === '.npmrc') {
    return 'npm auth/config file'
  }
  if (name === '.eslintcache') {
    return 'generated dependency/build output'
  }
  if (isEnvFile(name) && !isAllowedEnvExample(name)) {
    return '.env policy'
  }
  if (name === 'auth.json' || name === 'cookies.txt') {
    return 'local auth material'
  }
  if (name === 'vc_redist.x64.exe') {
    return 'Microsoft VC Redistributable licensing blocker'
  }
  if (
    lower.startsWith('.codex/') ||
    lower.startsWith('.codex-tmp/') ||
    lower.includes('/.codex/') ||
    lower.includes('/.codex-tmp/')
  ) {
    return 'Codex local state'
  }
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
  ) {
    return 'generated dependency/build output'
  }
  if (lower === 'open' || lower === 'private' || lower.startsWith('open/') || lower.startsWith('private/')) {
    return 'open/private workspace wrapper'
  }
  if (
    lower.startsWith('vendor/comfyui/comfyui_data/') ||
    lower.startsWith('vendor/comfyui/comfyui_windows_portable/') ||
    lower.startsWith('vendor/comfyui/python_embeded/') ||
    lower.startsWith('vendor/comfyui/comfyui/') ||
    lower.includes('/comfyui_windows_portable/')
  ) {
    return 'ComfyUI local runtime data'
  }

  return null
}

const copyTrackedFiles = (candidatePath, sourceRoot = repoRoot) => {
  const trackedFiles = readTrackedFiles(sourceRoot)
  const skipped = []
  let copied = 0

  removeDirectory(candidatePath)
  fs.mkdirSync(candidatePath, { recursive: true })

  for (const entry of trackedFiles) {
    const reason = getOpenCandidateExclusionReason(entry.file, entry.mode)
    if (reason) {
      skipped.push({ file: entry.file, reason })
      continue
    }

    const source = path.join(sourceRoot, entry.file)
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      skipped.push({ file: entry.file, reason: 'not a regular file' })
      continue
    }

    const destination = path.join(candidatePath, entry.file)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(source, destination)
    copied += 1
  }

  return { copied, skipped }
}

const collectCandidateFiles = (dir, candidatePath, files = [], issues = []) => {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const relativeEntry = toPosix(path.relative(candidatePath, fullPath))
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
    if (entry.isDirectory()) {
      collectCandidateFiles(fullPath, candidatePath, files, issues)
      continue
    }
    files.push(fullPath)
  }
  return files
}

const isLikelyTextFile = (file) => {
  const ext = path.extname(file).toLowerCase()
  if (textExtensions.has(ext)) {
    return true
  }
  const name = basenameLower(toPosix(file))
  return name.startsWith('.') && name !== '.png' && name !== '.exe'
}

const getLineNumber = (text, index) => text.slice(0, index).split(/\r?\n/).length

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

const addContentIssues = ({ file, relativeFile, text, issues }) => {
  const rules = [
    {
      rule: 'codex-functional-reference',
      pattern: codexFunctionalPattern
    },
    {
      rule: 'private-path-reference',
      pattern:
        /(?:[A-Za-z]:[\\/][^\r\n"'`]*(?:private|internal|premium|open-private)[\\/][^\r\n"'`]*)|(?:(?:^|[\\/"'`\s])(?:private|internal|premium|open-private)[\\/][^\r\n"'`\s)]+)/gi
    },
    {
      rule: 'high-confidence-secret',
      pattern:
        /(?:sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9_]{36,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----)/g
    }
  ]

  for (const { rule, pattern } of rules) {
    for (const match of text.matchAll(pattern)) {
      const line = getLineNumber(text, match.index ?? 0)
      issues.push({
        file: relativeFile,
        line,
        rule,
        message: match[0].slice(0, 160)
      })
    }
  }
}

export const auditOpenCandidate = (candidatePath) => {
  const issues = []
  const files = collectCandidateFiles(candidatePath, candidatePath, [], issues)

  for (const file of files) {
    const relativeFile = toPosix(path.relative(candidatePath, file))
    const reason = getOpenCandidateExclusionReason(relativeFile)
    if (reason) {
      issues.push({
        file: relativeFile,
        line: 1,
        rule: 'forbidden-candidate-file',
        message: reason
      })
      continue
    }
    if (!isLikelyTextFile(file)) {
      continue
    }
    const text = fs.readFileSync(file, 'utf8')
    addContentIssues({ file, relativeFile, text, issues })
  }

  return issues
}

const verifyCandidate = (candidatePath) => {
  const issues = auditOpenCandidate(candidatePath)
  if (issues.length > 0) {
    console.error(`Open candidate audit failed: ${issues.length} issue(s).`)
    for (const issue of issues.slice(0, 200)) {
      console.error(`${issue.file}:${issue.line} [${issue.rule}] ${issue.message}`)
    }
    if (issues.length > 200) {
      console.error(`... ${issues.length - 200} more issue(s) omitted.`)
    }
    const error = new Error('Open candidate audit failed')
    error.exitCode = 1
    throw error
  }
  console.log('Open candidate audit passed.')
}

export const createOpenCandidate = (candidatePath = defaultCandidatePath, sourceRoot = repoRoot) => {
  ensureInsideTrash(candidatePath)
  fs.mkdirSync(trashRoot, { recursive: true })
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const { copied, skipped } = copyTrackedFiles(candidatePath, sourceRoot)
  console.log(`Open candidate run id: ${runId}`)
  console.log(`Open candidate source: ${sourceRoot}`)
  console.log(`Open candidate path: ${candidatePath}`)
  console.log(`Copied files: ${copied}`)
  console.log(`Skipped files: ${skipped.length}`)
  verifyCandidate(candidatePath)
  return { runId, candidatePath, copied, skipped }
}

export const runVerifyMode = ({ keepVerifyCandidate = false, sourceRoot = repoRoot } = {}) => {
  if (!hasGitRepository(sourceRoot)) {
    verifyCandidate(sourceRoot)
    console.log(`Verified current candidate: ${sourceRoot}`)
    return { candidatePath: sourceRoot, auditCurrent: true }
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const verifyCandidatePath = path.join(trashRoot, `magicpot-open-candidate-check-${runId}`)
  ensureInsideTrash(verifyCandidatePath)
  try {
    copyTrackedFiles(verifyCandidatePath, sourceRoot)
    verifyCandidate(verifyCandidatePath)
    console.log(`Verified source: ${sourceRoot}`)
    console.log(`Verified temporary candidate: ${verifyCandidatePath}`)
    return { candidatePath: verifyCandidatePath, auditCurrent: false }
  } finally {
    if (!keepVerifyCandidate) {
      removeDirectory(verifyCandidatePath)
    }
  }
}

export const main = (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv)

  if (options.auditOnly) {
    verifyCandidate(options.target)
    return
  }

  if (options.verify) {
    runVerifyMode({ keepVerifyCandidate: options.keepVerifyCandidate, sourceRoot: options.source })
    return
  }

  createOpenCandidate(options.output, options.source)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    if (error?.exitCode) {
      process.exit(error.exitCode)
    }
    throw error
  }
}
