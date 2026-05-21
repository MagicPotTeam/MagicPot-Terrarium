/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.txt',
  '.yml',
  '.yaml',
  '.css',
  '.scss',
  '.html'
])
const SPECIAL_TEXT_FILES = new Set(['.editorconfig', '.gitattributes'])
const SKIP_SEGMENTS = new Set([
  '.git',
  '.codex-tmp',
  'node_modules',
  'dist',
  'out',
  '.aiengineelectron-dev',
  'comfyui'
])
const PRIVATE_USE_CHAR_PATTERN = /[\uE000-\uF8FF]/
const COMMENT_PLACEHOLDER_PATTERN = /(?:\?\s*){2,}/
const REPLACEMENT_CHAR = '\uFFFD'
const SUSPICIOUS_CHAR_CODES = [
  0x7481, 0x752f, 0x7586, 0x941c, 0x95ae, 0x8bb2, 0x934f, 0x7c2c, 0x95c1, 0x95b8, 0x20ac, 0x95bb,
  0x5a75, 0x95c2, 0x6924, 0x95b9, 0x7f01, 0x6fe0, 0x5b95, 0x93cc, 0x95ba, 0x68ba, 0x6fde, 0x67db,
  0x9227, 0x934b, 0x7039, 0x9410, 0x93ae, 0x9a9e, 0x599e, 0x5a34, 0x7f02, 0x682c, 0x7deb, 0x9350,
  0x546f, 0x93c2, 0x56e8, 0x6e70, 0x93bb, 0x5fda, 0x582a, 0x7035, 0x714e, 0x56ad, 0x30e7, 0x790c,
  0x93c9, 0x612e, 0x6b91, 0x93b5, 0x64b4, 0x7223, 0x5a0c, 0x590b, 0x8e48, 0x5fd4, 0x7161, 0x942a,
  0x2033, 0x7037, 0x6226, 0x57cc, 0x5a13, 0x544a, 0x5799, 0x66df, 0x6438
]
const SUSPICIOUS_CHAR_CLASS = SUSPICIOUS_CHAR_CODES.map(
  (code) => `\\u${code.toString(16).padStart(4, '0')}`
).join('')
const SUSPICIOUS_CHAR_PATTERN = new RegExp(`[${SUSPICIOUS_CHAR_CLASS}]`, 'g')

function normalizeCliFile(file) {
  return path.normalize(file.replace(/^['"]|['"]$/g, ''))
}

function shouldSkip(file) {
  return normalizeCliFile(file)
    .split(/[\\/]+/)
    .some((segment) => SKIP_SEGMENTS.has(segment))
}

function isTextLikeFile(file) {
  const normalized = normalizeCliFile(file)
  const baseName = path.basename(normalized)
  const extension = path.extname(baseName).toLowerCase()
  return SPECIAL_TEXT_FILES.has(baseName) || TEXT_EXTENSIONS.has(extension)
}

function listTrackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: process.cwd(), encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
}

function hasGitRepository() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore']
    })
    return true
  } catch {
    return false
  }
}

function walkCurrentDirectory(dir = process.cwd(), files = []) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const relativePath = path.relative(process.cwd(), fullPath)
    if (shouldSkip(relativePath)) {
      continue
    }
    if (entry.isDirectory()) {
      walkCurrentDirectory(fullPath, files)
      continue
    }
    files.push(relativePath)
  }
  return files
}

function listDefaultFiles() {
  return hasGitRepository() ? listTrackedFiles() : walkCurrentDirectory()
}

function dedupeFiles(files) {
  return [...new Set(files.map((file) => normalizeCliFile(file)).filter(Boolean))]
}

function describeSnippet(line) {
  return line.trim().replace(/\s+/g, ' ').slice(0, 160)
}

function isCommentLikeLine(line, inBlockComment) {
  const trimmed = line.trimStart()
  return (
    inBlockComment ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*')
  )
}

function updateBlockCommentState(line, inBlockComment) {
  const trimmed = line.trimStart()
  if (inBlockComment) {
    return !trimmed.includes('*/')
  }
  if (trimmed.startsWith('/*')) {
    return !trimmed.includes('*/')
  }
  return false
}

function hasSuspiciousMojibake(line, inBlockComment) {
  const isCommentLike = isCommentLikeLine(line, inBlockComment)
  if (line.includes(REPLACEMENT_CHAR) || PRIVATE_USE_CHAR_PATTERN.test(line)) return true
  if (isCommentLike && line.match(SUSPICIOUS_CHAR_PATTERN)?.length) return true
  if (isCommentLike && COMMENT_PLACEHOLDER_PATTERN.test(line)) return true
  return false
}

function checkFile(file) {
  const absolutePath = path.resolve(process.cwd(), file)
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(absolutePath))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    return [
      {
        file,
        line: 1,
        reason: 'invalid UTF-8 text file',
        snippet: error instanceof Error ? error.message : String(error)
      }
    ]
  }

  let inBlockComment = false
  return text.split(/\r?\n/).flatMap((line, index) => {
    const suspicious = hasSuspiciousMojibake(line, inBlockComment)
    inBlockComment = updateBlockCommentState(line, inBlockComment)

    if (!line || !suspicious) return []
    return [
      {
        file,
        line: index + 1,
        reason: 'suspicious mojibake detected',
        snippet: describeSnippet(line)
      }
    ]
  })
}

const filesToCheck = dedupeFiles(
  process.argv.length > 2 ? process.argv.slice(2) : listDefaultFiles()
).filter((file) => !shouldSkip(file) && isTextLikeFile(file))

const issues = filesToCheck.flatMap((file) => checkFile(file))

if (issues.length > 0) {
  console.error('Found suspicious encoding or placeholder text:')
  for (const issue of issues) {
    console.error(`- ${issue.file}:${issue.line} ${issue.reason}`)
    console.error(`  ${issue.snippet}`)
  }
  process.exit(1)
}

console.log(`Encoding check passed (${filesToCheck.length} files).`)
