import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = process.cwd()
const localeFiles = {
  'en-US': path.join(root, 'packages/app/src/shared/locales/en-US/renderer.json'),
  'zh-CN': path.join(root, 'packages/app/src/shared/locales/zh-CN/renderer.json')
}
const defaultBaselineFile = path.join(root, 'config/i18n/source-cjk-baseline.json')
const cjkPattern = /[\u3400-\u9fff]/
const replacementCharPattern = /\uFFFD/
const englishMojibakePattern = /\uFFFD|Ã|Â|â€|鈥/

export const normalizePathForReport = (file) => path.relative(root, file).replace(/\\/g, '/')

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
    baselineFile: path.resolve(options.get('--baseline') ?? defaultBaselineFile),
    scanSource:
      flags.has('--scan-source') || flags.has('--strict-source') || flags.has('--update-baseline'),
    strictSource: flags.has('--strict-source'),
    noBaseline: flags.has('--no-baseline'),
    updateBaseline: flags.has('--update-baseline')
  }
}

const issues = []

const addIssue = ({ file, line = 1, rule, message }) => {
  issues.push({ file: normalizePathForReport(file), line, rule, message })
}

const readJson = (locale, file) => {
  try {
    const text = fs.readFileSync(file, 'utf8')
    if (replacementCharPattern.test(text)) {
      addIssue({
        file,
        rule: 'locale-replacement-character',
        message: 'locale file contains the Unicode replacement character'
      })
    }
    if (locale === 'en-US' && englishMojibakePattern.test(text)) {
      addIssue({
        file,
        rule: 'english-locale-mojibake',
        message: 'English locale contains common mojibake markers'
      })
    }
    return JSON.parse(text)
  } catch (error) {
    addIssue({
      file,
      rule: 'locale-json',
      message: `failed to parse locale JSON: ${error instanceof Error ? error.message : String(error)}`
    })
    return {}
  }
}

const flatten = (value, prefix = '') => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      flatten(child, prefix ? `${prefix}.${key}` : key)
    )
  }

  return [{ key: prefix, value }]
}

const walkFiles = (dir, files = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(fullPath, files)
      continue
    }
    if (
      !/\.(tsx?|jsx?)$/.test(entry.name) ||
      /\.test\./.test(entry.name) ||
      /\.d\.ts$/.test(entry.name)
    ) {
      continue
    }
    files.push(fullPath)
  }
  return files
}

const scanSourceFile = (file) => {
  const text = fs.readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const hits = []

  const addSourceHit = (node, value, kind) => {
    if (!cjkPattern.test(value)) {
      return
    }
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    hits.push({
      file: normalizePathForReport(file),
      line: position.line + 1,
      kind,
      value: value.replace(/\s+/g, ' ').trim().slice(0, 240)
    })
  }

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      addSourceHit(node, node.text, ts.isStringLiteral(node) ? 'string' : 'template')
    } else if (ts.isJsxText(node)) {
      addSourceHit(node, node.getText(sourceFile).trim(), 'jsx-text')
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return hits
}

const scanRendererSource = () => {
  const sourceRoot = path.join(root, 'packages/app/src/renderer/src')
  return walkFiles(sourceRoot).flatMap(scanSourceFile)
}

export const groupSourceHits = (hits) => {
  const grouped = new Map()

  for (const hit of hits) {
    const key = `${hit.file}\0${hit.kind}\0${hit.value}`
    const existing = grouped.get(key)
    if (existing) {
      existing.count += 1
      existing.lines.push(hit.line)
      continue
    }
    grouped.set(key, {
      file: hit.file,
      kind: hit.kind,
      value: hit.value,
      count: 1,
      lines: [hit.line]
    })
  }

  return [...grouped.values()].sort((left, right) => {
    const fileCompare = left.file.localeCompare(right.file)
    if (fileCompare !== 0) {
      return fileCompare
    }
    const kindCompare = left.kind.localeCompare(right.kind)
    if (kindCompare !== 0) {
      return kindCompare
    }
    return left.value.localeCompare(right.value)
  })
}

const baselineKey = (entry) => `${entry.file}\0${entry.kind}\0${entry.value}`

const readBaseline = (baselineFile) => {
  if (!fs.existsSync(baselineFile)) {
    return null
  }

  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
  const entries = Array.isArray(baseline.entries) ? baseline.entries : []
  const counts = new Map()
  for (const entry of entries) {
    counts.set(baselineKey(entry), Number(entry.count) || 0)
  }
  return { entries, counts }
}

export const compareSourceHitsToBaseline = (hits, baselineEntries) => {
  const grouped = groupSourceHits(hits)
  const baselineCounts = new Map()
  for (const entry of baselineEntries) {
    baselineCounts.set(baselineKey(entry), Number(entry.count) || 0)
  }

  return grouped
    .map((entry) => ({
      ...entry,
      baselineCount: baselineCounts.get(baselineKey(entry)) ?? 0
    }))
    .filter((entry) => entry.count > entry.baselineCount)
}

const writeBaseline = (baselineFile, hits) => {
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true })
  const entries = groupSourceHits(hits).map(({ file, kind, value, count }) => ({
    file,
    kind,
    value,
    count
  }))
  fs.writeFileSync(
    baselineFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        description:
          'Existing renderer production CJK literal debt. check:i18n fails only on new entries above this baseline.',
        entries
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  return entries.length
}

const checkLocales = () => {
  const locales = Object.fromEntries(
    Object.entries(localeFiles).map(([locale, file]) => [locale, readJson(locale, file)])
  )
  const flattened = Object.fromEntries(
    Object.entries(locales).map(([locale, value]) => [locale, flatten(value)])
  )
  const localeKeySets = Object.fromEntries(
    Object.entries(flattened).map(([locale, entries]) => [
      locale,
      new Set(entries.map((entry) => entry.key))
    ])
  )
  const allKeys = new Set(Object.values(localeKeySets).flatMap((keys) => [...keys]))

  for (const key of allKeys) {
    for (const [locale, keys] of Object.entries(localeKeySets)) {
      if (!keys.has(key)) {
        addIssue({
          file: localeFiles[locale],
          rule: 'locale-key-parity',
          message: `missing translation key ${key}`
        })
      }
    }
  }

  for (const { key, value } of flattened['en-US'] ?? []) {
    if (typeof value === 'string' && cjkPattern.test(value)) {
      addIssue({
        file: localeFiles['en-US'],
        rule: 'english-locale-cjk',
        message: `English translation ${key} contains CJK text: ${value}`
      })
    }
  }
}

const checkI18nConfig = () => {
  const i18nConfigFile = path.join(root, 'packages/app/src/renderer/src/i18n.ts')
  const i18nConfigText = fs.existsSync(i18nConfigFile)
    ? fs.readFileSync(i18nConfigFile, 'utf8')
    : ''
  if (!/fallbackLng:\s*['"]en-US['"]/.test(i18nConfigText)) {
    addIssue({
      file: i18nConfigFile,
      rule: 'english-fallback',
      message: 'i18n fallbackLng must be en-US so English UI never falls back to Chinese copy'
    })
  }
  if (!/supportedLngs:\s*\[[^\]]*['"]en-US['"][^\]]*['"]zh-CN['"][^\]]*\]/s.test(i18nConfigText)) {
    addIssue({
      file: i18nConfigFile,
      rule: 'supported-languages',
      message: 'i18n supportedLngs must include en-US and zh-CN'
    })
  }
}

const reportIssuesAndExit = () => {
  if (issues.length === 0) {
    return
  }

  console.error('i18n check failed:')
  for (const issue of issues) {
    console.error(`${issue.file}:${issue.line} [${issue.rule}] ${issue.message}`)
  }
  process.exit(1)
}

export const main = (argv = process.argv.slice(2)) => {
  const options = parseArgs(argv)

  checkLocales()
  checkI18nConfig()

  let sourceHits = []
  if (options.scanSource) {
    sourceHits = scanRendererSource()

    if (options.updateBaseline) {
      reportIssuesAndExit()
      const baselineCount = writeBaseline(options.baselineFile, sourceHits)
      console.log(
        `i18n source CJK baseline updated: ${normalizePathForReport(options.baselineFile)} (${baselineCount} entries).`
      )
      return
    }

    if (options.strictSource) {
      const baseline = options.noBaseline ? null : readBaseline(options.baselineFile)
      const newHits = baseline
        ? compareSourceHitsToBaseline(sourceHits, baseline.entries)
        : groupSourceHits(sourceHits)

      for (const hit of newHits) {
        const extraCount =
          hit.baselineCount === undefined ? hit.count : hit.count - hit.baselineCount
        addIssue({
          file: path.join(root, hit.file),
          line: hit.lines[0] ?? 1,
          rule: `source-hardcoded-cjk:${hit.kind}`,
          message: `${hit.value} (new occurrences: ${extraCount})`
        })
      }
    }
  }

  reportIssuesAndExit()

  console.log('i18n check passed.')
  if (options.scanSource) {
    const baseline = options.noBaseline ? null : readBaseline(options.baselineFile)
    const baselineSize = baseline?.entries.length ?? 0
    console.log(`Renderer source CJK literal scan: ${sourceHits.length} hit(s).`)
    if (options.strictSource) {
      console.log(`Renderer source CJK baseline entries: ${baselineSize}.`)
      console.log('No new renderer source CJK literals were found beyond the baseline.')
    } else {
      for (const hit of sourceHits.slice(0, 50)) {
        console.log(`${hit.file}:${hit.line} [${hit.kind}] ${hit.value}`)
      }
      if (sourceHits.length > 50) {
        console.log(`... ${sourceHits.length - 50} more hit(s) omitted.`)
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
