#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import vm from 'node:vm'
import ts from 'typescript'
import {
  assertNonIntrusiveWindowPlacement,
  buildNonIntrusiveTestWindowEnv,
  resolveProjectCanvasBenchmarkDesktopPath,
  resolveProjectCanvasArtifactRoot,
  sanitizeProjectCanvasRunId
} from './projectCanvas/benchmarkPolicy.mjs'

const repoRoot = process.cwd()
const trashRoot = path.resolve(path.join(resolveProjectCanvasBenchmarkDesktopPath(), '.magicpot-trash'))
const execFileAsync = promisify(execFile)
const ROOT_RUNTIME_TRASH_DIR_PATTERNS = [
  /^\.magicpot-trash$/i,
  /^(?:automationSchemes|customChecks)$/i,
  /^(?:node-tests|screenshots?|test-results|playwright-report|artifacts?|benchmark-results)$/i,
  /^(?:startup-smoke|magicpot-(?:overlay|webgl|video|real-board)-benchmark)[-_].*/i
]
const ROOT_RUNTIME_TRASH_ALLOWLIST = new Set([
  'automationSchemes/automation_1775062956608_2qtex2.automation.json'
])

const checks = [
  {
    file: 'packages/app/src/main/testUiPolicy.ts',
    mustInclude: ['sanitizeTestUiRunId', '.magicpot-trash', 'secondary-or-offscreen']
  },
  {
    file: 'packages/app/src/main/testWindowRuntime.ts',
    mustInclude: [
      'readTestUiEnv',
      'resolveTestUiPolicy',
      'resolveTestWindowPlacement',
      'showInactive',
      'setSkipTaskbar',
      'shouldHideCurrentTestWindow'
    ]
  },
  {
    file: 'packages/app/src/main/mainWindow.ts',
    mustInclude: [
      'resolveTestArtifactPath',
      'showWindowForTestPolicy',
      'skipTaskbar',
      'show: false'
    ]
  },
  {
    file: 'packages/app/src/main/screenshot/screenshotManager.ts',
    mustInclude: [
      'readTestUiEnv',
      'resolveTestUiPolicy',
      'resolveTestWindowPlacement',
      'resolveTestArtifactPath',
      'showInactive',
      'skipTaskbar'
    ]
  },
  {
    file: 'packages/app/src/main/startup.smoke.test.ts',
    mustInclude: [
      'assessTestWindowPlacement',
      'MAGICPOT_TEST_UI_MODE',
      'secondary-or-offscreen',
      'skipTaskbar'
    ]
  },
  {
    file: 'packages/app/src/preload/index.d.ts',
    mustInclude: ['api: Api']
  },
  {
    file: 'scripts/projectCanvas/benchmarkPolicy.mjs',
    mustInclude: [
      'sanitizeProjectCanvasRunId',
      'resolveProjectCanvasArtifactRoot',
      'MAGICPOT_TEST_ARTIFACT_ROOT',
      'assertNonIntrusiveWindowPlacement'
    ]
  },
  {
    file: 'scripts/projectCanvas/webglBenchmark.mjs',
    mustInclude: [
      './benchmarkPolicy.mjs',
      'assertNonIntrusiveWindowPlacement',
      'resolveProjectCanvasArtifactRoot'
    ]
  },
  {
    file: 'scripts/projectCanvas/overlayBenchmark.mjs',
    mustInclude: [
      './benchmarkPolicy.mjs',
      'assertNonIntrusiveWindowPlacement',
      'resolveProjectCanvasArtifactRoot'
    ]
  },
  {
    file: 'scripts/projectCanvas/videoBenchmark.mjs',
    mustInclude: [
      './benchmarkPolicy.mjs',
      'assertNonIntrusiveWindowPlacement',
      'resolveProjectCanvasArtifactRoot'
    ]
  },
  {
    file: 'scripts/projectCanvas/realBoardBenchmark.mjs',
    mustInclude: [
      './benchmarkPolicy.mjs',
      'assertNonIntrusiveWindowPlacement',
      'resolveProjectCanvasArtifactRoot',
      'MAGICPOT_REAL_BOARD_IMAGE_DIR',
      'MAGICPOT_REAL_BOARD_PRESSURE_DURATION_MS'
    ]
  },
  {
    file: 'scripts/projectCanvas/devWatcherProbe.mjs',
    mustInclude: [
      './benchmarkPolicy.mjs',
      'buildNonIntrusiveTestWindowEnv',
      'resolveProjectCanvasArtifactRoot',
      '.magicpot-trash',
      'WATCH_EVENT_PATTERN'
    ]
  },
  {
    file: 'package.json',
    mustInclude: [
      'probe:project-canvas:dev-watch',
      'MAGICPOT_REAL_BOARD_PRESSURE_DURATION_MS=15000',
      'benchmark:project-canvas:real-board:import-1800:raw',
      'MAGICPOT_REAL_BOARD_MODE=import MAGICPOT_REAL_BOARD_IMAGE_COUNT=1800',
      'benchmark:project-canvas:real-board:mixed-3000:raw',
      'MAGICPOT_REAL_BOARD_MODE=mixed MAGICPOT_REAL_BOARD_IMAGE_COUNT=3000'
    ]
  },
  {
    file: 'packages/app/src/renderer/src/pages/ProjectCanvasPage/ProjectCanvasPage.fileIntake.test.ts',
    mustInclude: [
      "expect(ALL_ACCEPT).not.toContain('.pur')",
      "expect(CANVAS_IMPORT_ACCEPT).not.toContain('.pur')",
      'rejects unsupported .pur files from the canvas intake gate'
    ]
  },
  {
    file: 'packages/app/src/renderer/src/pages/ProjectCanvasPage/useCanvasFileIntake.ts',
    mustInclude: [
      'isUnsupportedPureRefFile',
      'notifyWarning',
      'PureRef .pur files are not supported by MagicPot Project Canvas.'
    ]
  },
  {
    file: 'packages/app/src/renderer/src/pages/ProjectCanvasPage/useCanvasFileIntake.test.tsx',
    mustInclude: [
      'explicitly rejects unsupported .pur drops',
      'PureRef .pur files are not supported by MagicPot Project Canvas.'
    ]
  },
  {
    file: 'packages/app/src/main/mcp/platform/mcpPlatform.ts',
    mustInclude: [
      'startStdio',
      'startStreamableHttp',
      'platform.health',
      'platform.audit.list',
      'registerResource',
      'registerPrompt'
    ]
  },
  {
    file: 'packages/app/src/main/mcp/platform/capabilityRegistry.ts',
    mustInclude: ['checkPermission', 'default-read-only', 'default-deny', 'platform-inspection']
  },
  {
    file: 'packages/app/src/main/mcp/platform/transports.ts',
    mustInclude: ['StdioServerTransport', 'StreamableHTTPServerTransport']
  },
  {
    file: 'packages/app/src/main/agentKernel/agentKernel.ts',
    mustInclude: [
      'registerSession',
      'registerCapability',
      'invokeTool',
      'createMasterRun',
      'createSubagentRun'
    ]
  }
]
const forbiddenProjectCanvasPurPaths = [
  'packages/app/src/renderer/src/pages/ProjectCanvasPage/purParser.ts',
  'packages/app/src/renderer/src/pages/ProjectCanvasPage/canvasPurImport.ts',
  'packages/app/src/renderer/src/pages/ProjectCanvasPage/canvasPurImport.test.ts'
]

function staysWithinTrashRoot(targetPath) {
  const relativePath = path.relative(trashRoot, path.resolve(targetPath))
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

async function loadTypeScriptModule(relativeFilePath) {
  const absolutePath = path.resolve(repoRoot, relativeFilePath)
  const source = await readFile(absolutePath, 'utf8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    },
    fileName: absolutePath
  }).outputText
  const module = { exports: {} }
  const requireFromFile = createRequire(absolutePath)
  const dirname = path.dirname(absolutePath)
  const wrapper = vm.runInNewContext(
    `(function (exports, require, module, __filename, __dirname) {${transpiled}\n})`,
    {
      Buffer,
      clearImmediate,
      clearInterval,
      clearTimeout,
      console,
      process,
      setImmediate,
      setInterval,
      setTimeout
    },
    { filename: absolutePath }
  )

  wrapper(module.exports, requireFromFile, module, absolutePath, dirname)
  return module.exports
}

async function pathExists(relativeFilePath) {
  try {
    await stat(path.resolve(repoRoot, relativeFilePath))
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function normalizeRelativePath(filePath) {
  return path.relative(repoRoot, path.resolve(filePath)).replace(/[\\/]+/g, '/')
}

async function collectSourceFiles(relativeDirectoryPath, files = []) {
  const absoluteDirectoryPath = path.resolve(repoRoot, relativeDirectoryPath)
  let entries
  try {
    entries = await readdir(absoluteDirectoryPath, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return files
    }
    throw error
  }

  for (const entry of entries) {
    const absoluteEntryPath = path.join(absoluteDirectoryPath, entry.name)
    if (entry.isDirectory()) {
      if (['.git', 'dist', 'node_modules', 'out'].includes(entry.name)) {
        continue
      }
      await collectSourceFiles(normalizeRelativePath(absoluteEntryPath), files)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const extension = path.extname(entry.name)
    if (['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'].includes(extension)) {
      files.push(absoluteEntryPath)
    }
  }

  return files
}

function isTestSourceFile(filePath) {
  const normalizedPath = normalizeRelativePath(filePath)
  return (
    /(^|\/)(__tests__|test|tests)(\/|$)/.test(normalizedPath) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalizedPath)
  )
}

function collectModuleSpecifiers(filePath, source) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
  const specifiers = []

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    }

    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const [firstArgument] = node.arguments
      const expression = node.expression
      const isDynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequireCall = ts.isIdentifier(expression) && expression.text === 'require'

      if ((isDynamicImport || isRequireCall) && ts.isStringLiteralLike(firstArgument)) {
        specifiers.push(firstArgument.text)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

function pointsToLegacyChatBotRuntime(filePath, specifier) {
  const normalizedSpecifier = specifier.replace(/[\\/]+/g, '/')
  if (
    normalizedSpecifier === 'packages/app/src/main/chatBot' ||
    normalizedSpecifier.startsWith('packages/app/src/main/chatBot/')
  ) {
    return true
  }

  if (!normalizedSpecifier.startsWith('.')) {
    return false
  }

  const resolvedPath = path
    .relative(repoRoot, path.resolve(path.dirname(filePath), normalizedSpecifier))
    .replace(/[\\/]+/g, '/')

  return (
    resolvedPath === 'packages/app/src/main/chatBot' ||
    resolvedPath.startsWith('packages/app/src/main/chatBot/')
  )
}

async function runRuntimeUniquenessChecks(lines) {
  let failures = 0
  const assistantRuntimePath = 'packages/app/src/main/assistantRuntime/runtime.ts'
  const legacyChatBotRuntimePath = 'packages/app/src/main/chatBot'

  if (!(await pathExists(assistantRuntimePath))) {
    failures += 1
    lines.push(`[FAIL] runtime uniqueness: missing ${assistantRuntimePath}`)
  } else {
    lines.push(`[PASS] runtime uniqueness: ${assistantRuntimePath}`)
  }

  if (await pathExists(legacyChatBotRuntimePath)) {
    failures += 1
    lines.push(
      `[FAIL] runtime uniqueness: ${legacyChatBotRuntimePath} must not exist as a parallel runtime`
    )
  } else {
    lines.push('[PASS] runtime uniqueness: no packages/app/src/main/chatBot parallel runtime')
  }

  const productionSourceRoots = [
    'packages/app/src/main',
    'packages/app/src/preload',
    'packages/app/src/shared',
    'packages/app/src/renderer/src'
  ]
  const sourceFiles = (
    await Promise.all(productionSourceRoots.map((root) => collectSourceFiles(root)))
  )
    .flat()
    .filter((filePath) => !isTestSourceFile(filePath))

  const importViolations = []
  for (const filePath of sourceFiles) {
    const source = await readFile(filePath, 'utf8')
    const specifiers = collectModuleSpecifiers(filePath, source)
    for (const specifier of specifiers) {
      if (pointsToLegacyChatBotRuntime(filePath, specifier)) {
        importViolations.push(`${normalizeRelativePath(filePath)} imports ${specifier}`)
      }
    }
  }

  if (importViolations.length > 0) {
    failures += 1
    lines.push(
      `[FAIL] runtime uniqueness: production code imports legacy chatBot runtime: ${importViolations.join('; ')}`
    )
  } else {
    lines.push('[PASS] runtime uniqueness: production imports stay on assistantRuntime')
  }

  return failures
}

async function runBehaviorChecks(lines) {
  const testUiPolicy = await loadTypeScriptModule('packages/app/src/main/testUiPolicy.ts')
  const automatedPolicy = testUiPolicy.resolveTestUiPolicy(
    {
      windowMode: undefined,
      noFocus: false,
      automatedRun: true,
      runId: '../../desktop takeover'
    },
    { now: 123, pid: 456 }
  )
  assert.equal(automatedPolicy.windowMode, 'secondary-or-offscreen')
  assert.equal(automatedPolicy.preferSecondaryDisplay, true)
  assert.equal(automatedPolicy.forceOffscreen, false)
  assert.equal(automatedPolicy.showBehavior, 'show-inactive')
  assert.equal(automatedPolicy.runId, 'desktop-takeover')

  const benchmarkEnv = buildNonIntrusiveTestWindowEnv('../../evil benchmark')
  const benchmarkWindowPolicy = testUiPolicy.resolveTestUiPolicy(
    {
      windowMode: benchmarkEnv.MAGICPOT_TEST_UI_MODE,
      noFocus: benchmarkEnv.MAGICPOT_TEST_NO_FOCUS === '1',
      automatedRun: benchmarkEnv.MAGICPOT_TEST_AUTOMATED_RUN === '1',
      runId: benchmarkEnv.MAGICPOT_TEST_RUN_ID
    },
    { now: 123, pid: 456 }
  )
  assert.equal(benchmarkWindowPolicy.windowMode, 'secondary-or-offscreen')
  assert.equal(benchmarkWindowPolicy.showBehavior, 'show-inactive')
  assert.equal(benchmarkWindowPolicy.runId, 'evil-benchmark')

  const automatedArtifactRoot = testUiPolicy.resolveTestArtifactRoot({
    desktopPath: resolveProjectCanvasBenchmarkDesktopPath(),
    tempPath: process.env.TEMP || process.env.TMP || '',
    policy: {
      automatedRun: true,
      runId: '../../desktop takeover',
      artifactRootOverride: undefined
    }
  })
  assert.equal(staysWithinTrashRoot(automatedArtifactRoot), true)

  const secondaryPlacement = testUiPolicy.resolveTestWindowPlacement({
    width: 1200,
    height: 800,
    displays: [
      { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } }
    ],
    primaryDisplayId: 1,
    policy: {
      hideWindow: false,
      preferSecondaryDisplay: true,
      forceOffscreen: false
    }
  })
  assert.equal(secondaryPlacement.x, 2600)
  assert.equal(secondaryPlacement.y, 320)

  const offscreenFallbackPlacement = testUiPolicy.resolveTestWindowPlacement({
    width: 1200,
    height: 800,
    displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    primaryDisplayId: 1,
    policy: {
      hideWindow: false,
      preferSecondaryDisplay: true,
      forceOffscreen: false
    }
  })
  assert.equal(offscreenFallbackPlacement.x, 2040)
  assert.equal(offscreenFallbackPlacement.y, 120)

  const overlapAssessment = testUiPolicy.assessTestWindowPlacement({
    bounds: { x: 1800, y: 100, width: 600, height: 800 },
    displays: [
      { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } }
    ],
    primaryDisplayId: 1,
    policy: {
      hideWindow: false,
      preferSecondaryDisplay: true,
      forceOffscreen: true
    }
  })
  assert.equal(overlapAssessment.expectedMode, 'secondary-display')
  assert.equal(overlapAssessment.shouldHideWindow, true)
  lines.push('[PASS] behavioral testUiPolicy checks')

  assert.equal(benchmarkEnv.MAGICPOT_TEST_UI_MODE, 'secondary-or-offscreen')
  assert.equal(benchmarkEnv.MAGICPOT_TEST_WINDOW_MODE, 'secondary-or-offscreen')
  assert.equal(benchmarkEnv.MAGICPOT_TEST_RUN_ID, 'evil-benchmark')
  assert.equal(sanitizeProjectCanvasRunId('../../evil benchmark'), 'evil-benchmark')
  assert.equal(staysWithinTrashRoot(resolveProjectCanvasArtifactRoot('../../evil benchmark')), true)

  assert.doesNotThrow(() =>
    assertNonIntrusiveWindowPlacement(
      {
        bounds: { x: 2200, y: 100, width: 1200, height: 800 },
        displays: [
          { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
          { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } }
        ],
        focusable: false,
        focused: false,
        primaryDisplayId: 1,
        skipTaskbar: true,
        visible: true
      },
      'QA benchmark placement'
    )
  )
  assert.throws(() =>
    assertNonIntrusiveWindowPlacement(
      {
        bounds: { x: 1800, y: 100, width: 600, height: 800 },
        displays: [
          { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
          { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } }
        ],
        focusable: false,
        focused: false,
        primaryDisplayId: 1,
        skipTaskbar: true,
        visible: true
      },
      'QA benchmark placement'
    )
  )
  lines.push('[PASS] behavioral projectCanvas benchmark policy checks')
}

function getUntrackedPathFromStatusLine(line) {
  if (!line.startsWith('?? ')) {
    return null
  }

  return line.slice(3).trim().replace(/^"|"$/g, '')
}

function getTopLevelSegment(relativePath) {
  return relativePath.split(/[\\/]+/).filter(Boolean)[0] || ''
}

async function isInsideGitWorkTree() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoRoot,
      windowsHide: true
    })
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function runRepoRootPollutionCheck(lines) {
  if (!(await isInsideGitWorkTree())) {
    lines.push('[PASS] repo root runtime artifact pollution check: skipped outside git worktree')
    return
  }

  const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-uall', '--'], {
    cwd: repoRoot,
    windowsHide: true
  })
  const untrackedRoots = new Map()

  for (const line of stdout.split(/\r?\n/)) {
    const relativePath = getUntrackedPathFromStatusLine(line)
    if (!relativePath) {
      continue
    }

    if (ROOT_RUNTIME_TRASH_ALLOWLIST.has(relativePath.replace(/[\\/]+/g, '/'))) {
      continue
    }

    const root = getTopLevelSegment(relativePath)
    if (!root) {
      continue
    }

    if (!untrackedRoots.has(root)) {
      untrackedRoots.set(root, [])
    }
    untrackedRoots.get(root).push(relativePath)
  }

  const runtimeTrashRoots = [...untrackedRoots.keys()].filter((root) =>
    ROOT_RUNTIME_TRASH_DIR_PATTERNS.some((pattern) => pattern.test(root))
  )

  if (runtimeTrashRoots.length > 0) {
    throw new Error(
      `repo root contains untracked runtime artifact directories: ${runtimeTrashRoots.join(', ')}`
    )
  }

  lines.push('[PASS] repo root runtime artifact pollution check')
}

let failures = 0
const lines = []

try {
  await runBehaviorChecks(lines)
} catch (error) {
  failures += 1
  lines.push(
    `[FAIL] behavioral policy checks: ${error instanceof Error ? error.message : String(error)}`
  )
}

try {
  await runRepoRootPollutionCheck(lines)
} catch (error) {
  failures += 1
  lines.push(
    `[FAIL] repo root runtime artifact pollution check: ${
      error instanceof Error ? error.message : String(error)
    }`
  )
}

try {
  failures += await runRuntimeUniquenessChecks(lines)
} catch (error) {
  failures += 1
  lines.push(
    `[FAIL] runtime uniqueness checks: ${error instanceof Error ? error.message : String(error)}`
  )
}

for (const forbiddenPath of forbiddenProjectCanvasPurPaths) {
  if (await pathExists(forbiddenPath)) {
    failures += 1
    lines.push(`[FAIL] ${forbiddenPath}: .pur support must remain removed`)
    continue
  }

  lines.push(`[PASS] ${forbiddenPath}: absent`)
}

for (const check of checks) {
  const absolutePath = path.resolve(repoRoot, check.file)
  const content = await readFile(absolutePath, 'utf8')
  const missing = check.mustInclude.filter((needle) => !content.includes(needle))

  if (missing.length > 0) {
    failures += 1
    lines.push(`[FAIL] ${check.file}: missing ${missing.join(', ')}`)
    continue
  }

  lines.push(`[PASS] ${check.file}`)
}

for (const line of lines) {
  console.log(line)
}

if (failures > 0) {
  process.exitCode = 1
  console.error(`\n${failures} policy check(s) failed.`)
} else {
  console.log('\nAll QA/security posture checks passed.')
}
