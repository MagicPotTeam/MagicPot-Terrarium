import { existsSync } from 'fs'
import { posix as pathPosix, sep, win32 as pathWin32 } from 'path'

export type TestUiWindowMode =
  | 'secondary-display'
  | 'offscreen'
  | 'secondary-or-offscreen'
  | 'hidden'

export type TestUiWindowShowBehavior = 'show' | 'show-inactive' | 'hidden'

export type TestUiDisplayLike = {
  id: number
  workArea: {
    x: number
    y: number
    width: number
    height: number
  }
}

export type TestUiEnvContract = {
  windowMode?: TestUiWindowMode
  noFocus: boolean
  automatedRun: boolean
  runId?: string
  artifactRootOverride?: string
}

export type TestUiPolicy = {
  automatedRun: boolean
  windowMode?: TestUiWindowMode
  noFocus: boolean
  hideWindow: boolean
  preferSecondaryDisplay: boolean
  forceOffscreen: boolean
  suppressTaskbar: boolean
  showBehavior: TestUiWindowShowBehavior
  runId: string
  artifactRootOverride?: string
}

export type TestUiWindowPlacement = {
  x: number
  y: number
}

export type TestUiWindowBounds = TestUiWindowPlacement & {
  width: number
  height: number
}

export type TestUiPlacementAssessment = {
  intersectingDisplayIds: number[]
  expectedMode: 'hidden' | 'secondary-display' | 'offscreen' | 'none'
  shouldHideWindow: boolean
}

export type ResolveTestWindowPlacementParams = {
  width: number
  height: number
  displays: TestUiDisplayLike[]
  primaryDisplayId: number
  policy: Pick<TestUiPolicy, 'hideWindow' | 'preferSecondaryDisplay' | 'forceOffscreen'>
}

export type ResolveTestWindowOverrideParams = {
  x?: number | null
  y?: number | null
  policy: Pick<TestUiPolicy, 'automatedRun'>
}

export type ResolveTestArtifactPathParams = {
  desktopPath: string
  tempPath: string
  policy: Pick<TestUiPolicy, 'automatedRun' | 'runId' | 'artifactRootOverride'>
  segments: string[]
}

const TEST_UI_POLICY_LOG_PREFIX = '[TestUiPolicy]'
const TEST_UI_ARTIFACT_ROOT_DIR = '.magicpot-trash'
const TEST_UI_RUN_ID_SAFE_PATTERN = /[^a-zA-Z0-9_-]+/g

function logTestUiPolicyDecision(context: string, details: Record<string, unknown>): void {
  console.log(`${TEST_UI_POLICY_LOG_PREFIX} ${context}`, JSON.stringify(details))
}

function normalizeTrimmed(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function resolveConfiguredDesktopPath(
  desktopPath: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return normalizeTrimmed(env['MAGICPOT_TEST_DESKTOP_PATH']) ?? desktopPath
}

function parseBooleanFlag(value: string | undefined | null): boolean {
  const trimmed = value?.trim().toLowerCase()
  return trimmed === '1' || trimmed === 'true' || trimmed === 'yes'
}

function isLikelyWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value)
}

function getPathModuleForValue(...values: string[]) {
  return values.some((value) => isLikelyWindowsAbsolutePath(value)) ? pathWin32 : pathPosix
}

function joinWithPathStyle(root: string, ...segments: string[]): string {
  return getPathModuleForValue(root, ...segments).join(root, ...segments)
}

function resolveWithPathStyle(root: string, ...segments: string[]): string {
  return getPathModuleForValue(root, ...segments).resolve(root, ...segments)
}

function resolveDefaultArtifactBasePath(): string {
  const configuredBase = normalizeTrimmed(process.env['MAGICPOT_TEST_ARTIFACT_BASE'])
  if (configuredBase) {
    return configuredBase
  }

  const cwd = process.cwd()
  const pathModule = getPathModuleForValue(cwd)
  const possiblePrivateRepoRoot = pathModule.resolve(cwd, '..', '..')
  if (
    pathModule.basename(pathModule.dirname(cwd)) === 'open' &&
    existsSync(pathModule.join(possiblePrivateRepoRoot, 'private', 'codex'))
  ) {
    return possiblePrivateRepoRoot
  }

  return cwd
}
function normalizeDisplaySet(
  displays: TestUiDisplayLike[]
): Array<{ id: number; workArea: TestUiDisplayLike['workArea'] }> {
  return displays.map((display) => ({
    id: display.id,
    workArea: {
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height
    }
  }))
}

function parseWindowMode(value: string | undefined | null): TestUiWindowMode | undefined {
  const trimmed = value?.trim().toLowerCase()
  switch (trimmed) {
    case 'secondary-display':
    case 'offscreen':
    case 'secondary-or-offscreen':
    case 'hidden':
      return trimmed
    default:
      return undefined
  }
}

function isInsideDirectory(candidatePath: string, parentPath: string): boolean {
  const pathModule = getPathModuleForValue(candidatePath, parentPath)
  const normalizedParent = pathModule.resolve(parentPath)
  const normalizedCandidate = pathModule.resolve(candidatePath)
  const relation = pathModule.relative(normalizedParent, normalizedCandidate)
  return relation === '' || (!relation.startsWith('..') && !pathModule.isAbsolute(relation))
}

function sanitizeArtifactSegments(segments: string[]): string[] {
  return segments
    .flatMap((segment) =>
      segment
        .split(/[\\/]+/)
        .map((part) => part.trim())
        .filter((part) => part && part !== '.' && part !== '..' && part !== sep)
    )
    .filter((part) => part)
}

function buildOffscreenPlacement(
  displays: TestUiDisplayLike[],
  width: number,
  height: number
): TestUiWindowPlacement {
  if (displays.length === 0) {
    return {
      x: width + 120,
      y: height + 120
    }
  }

  const unionRight = Math.max(
    ...displays.map((display) => display.workArea.x + display.workArea.width)
  )
  const unionTop = Math.min(...displays.map((display) => display.workArea.y))

  return {
    x: unionRight + 120,
    y: unionTop + 120
  }
}

export function createTestUiRunId(now = Date.now(), pid = process.pid): string {
  return `run-${now.toString(36)}-${pid.toString(36)}`
}

export function sanitizeTestUiRunId(
  value: string | undefined | null,
  fallback = createTestUiRunId()
): string {
  const normalized = normalizeTrimmed(value)
  const sanitized = normalized
    ?.replace(/[\\/]+/g, '-')
    .replace(TEST_UI_RUN_ID_SAFE_PATTERN, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return sanitized || fallback
}

export function readTestUiEnv(env: NodeJS.ProcessEnv = process.env): TestUiEnvContract {
  const windowMode = parseWindowMode(
    env['MAGICPOT_TEST_UI_MODE'] ?? env['MAGICPOT_TEST_WINDOW_MODE']
  )

  return {
    windowMode,
    noFocus: parseBooleanFlag(env['MAGICPOT_TEST_NO_FOCUS']),
    automatedRun:
      Boolean(windowMode) ||
      parseBooleanFlag(env['RUN_ELECTRON_STARTUP_SMOKE']) ||
      parseBooleanFlag(env['MAGICPOT_TEST_AUTOMATED_RUN']),
    runId:
      normalizeTrimmed(env['MAGICPOT_TEST_RUN_ID']) ??
      normalizeTrimmed(env['MAGICPOT_TEST_UI_RUN_ID']),
    artifactRootOverride:
      normalizeTrimmed(env['MAGICPOT_TEST_ARTIFACT_ROOT']) ??
      normalizeTrimmed(env['MAGICPOT_TEST_UI_ARTIFACT_ROOT'])
  }
}

export function resolveTestUiPolicy(
  contract: TestUiEnvContract,
  options?: {
    now?: number
    pid?: number
  }
): TestUiPolicy {
  const hasExplicitWindowMode = contract.windowMode !== undefined
  const windowMode =
    contract.windowMode || (contract.automatedRun ? 'secondary-or-offscreen' : undefined)

  const noFocus = contract.noFocus || contract.automatedRun
  const hideWindow = windowMode === 'hidden'
  const preferSecondaryDisplay =
    windowMode === 'secondary-display' || windowMode === 'secondary-or-offscreen'
  const forceOffscreen = windowMode === 'offscreen'
  const suppressTaskbar = hideWindow || preferSecondaryDisplay || forceOffscreen
  const showBehavior: TestUiWindowShowBehavior = hideWindow
    ? 'hidden'
    : noFocus || suppressTaskbar
      ? 'show-inactive'
      : 'show'

  const policy: TestUiPolicy = {
    automatedRun: contract.automatedRun,
    windowMode,
    noFocus,
    hideWindow,
    preferSecondaryDisplay,
    forceOffscreen,
    suppressTaskbar,
    showBehavior,
    runId: sanitizeTestUiRunId(contract.runId, createTestUiRunId(options?.now, options?.pid)),
    artifactRootOverride: contract.artifactRootOverride
  }

  logTestUiPolicyDecision('resolve-policy', {
    explicitWindowMode: hasExplicitWindowMode,
    selectedWindowMode: policy.windowMode,
    automatedRun: policy.automatedRun,
    noFocus: policy.noFocus,
    hideWindow: policy.hideWindow,
    suppressTaskbar: policy.suppressTaskbar,
    showBehavior: policy.showBehavior,
    rawRunIdInput: normalizeTrimmed(contract.runId) ?? null,
    sanitizedRunId: policy.runId,
    policyArtifactRootOverride: contract.artifactRootOverride ?? null
  })

  return policy
}

export function resolveTestWindowPlacement(
  params: ResolveTestWindowPlacementParams
): TestUiWindowPlacement | null {
  const placementContext = {
    policy: params.policy,
    displays: normalizeDisplaySet(params.displays),
    requestedSize: {
      width: params.width,
      height: params.height
    },
    primaryDisplayId: params.primaryDisplayId
  }

  if (params.policy.hideWindow) {
    logTestUiPolicyDecision('window-placement-skipped-hidden', placementContext)
    return null
  }

  const secondaryDisplay = params.displays.find((display) => display.id !== params.primaryDisplayId)

  if (params.policy.preferSecondaryDisplay) {
    if (secondaryDisplay) {
      const centeredPlacement: TestUiWindowPlacement = {
        x:
          secondaryDisplay.workArea.x +
          Math.max(0, Math.floor((secondaryDisplay.workArea.width - params.width) / 2)),
        y:
          secondaryDisplay.workArea.y +
          Math.max(0, Math.floor((secondaryDisplay.workArea.height - params.height) / 2))
      }

      logTestUiPolicyDecision('window-placement-secondary-centered', {
        ...placementContext,
        placement: centeredPlacement
      })

      return centeredPlacement
    }

    const fallbackPlacement = buildOffscreenPlacement(params.displays, params.width, params.height)
    logTestUiPolicyDecision('window-placement-secondary-missing-fallback-offscreen', {
      ...placementContext,
      placement: fallbackPlacement
    })
    return fallbackPlacement
  }

  if (params.policy.forceOffscreen) {
    const offscreenPlacement = buildOffscreenPlacement(params.displays, params.width, params.height)
    logTestUiPolicyDecision('window-placement-offscreen', {
      ...placementContext,
      placement: offscreenPlacement
    })
    return offscreenPlacement
  }

  logTestUiPolicyDecision('window-placement-default', {
    ...placementContext,
    placement: null
  })
  return null
}

export function resolveTestWindowOverride(
  params: ResolveTestWindowOverrideParams
): TestUiWindowPlacement | null {
  if (params.policy.automatedRun) {
    logTestUiPolicyDecision('window-override-ignored-automated', {
      automatedRun: params.policy.automatedRun,
      x: params.x,
      y: params.y
    })
    return null
  }

  if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
    logTestUiPolicyDecision('window-override-invalid', {
      automatedRun: params.policy.automatedRun,
      x: params.x,
      y: params.y
    })
    return null
  }

  const placement = {
    x: Math.trunc(Number(params.x)),
    y: Math.trunc(Number(params.y))
  }

  logTestUiPolicyDecision('window-override', placement)
  return placement
}

function rectanglesIntersect(left: TestUiWindowBounds, right: TestUiWindowBounds): boolean {
  const leftRight = left.x + left.width
  const leftBottom = left.y + left.height
  const rightRight = right.x + right.width
  const rightBottom = right.y + right.height

  return left.x < rightRight && leftRight > right.x && left.y < rightBottom && leftBottom > right.y
}

export function assessTestWindowPlacement(params: {
  bounds: TestUiWindowBounds
  displays: TestUiDisplayLike[]
  primaryDisplayId: number
  policy: Pick<TestUiPolicy, 'hideWindow' | 'preferSecondaryDisplay' | 'forceOffscreen'>
}): TestUiPlacementAssessment {
  if (params.policy.hideWindow) {
    return {
      intersectingDisplayIds: [],
      expectedMode: 'hidden',
      shouldHideWindow: true
    }
  }

  const intersectingDisplayIds = params.displays
    .filter((display) =>
      rectanglesIntersect(params.bounds, {
        x: display.workArea.x,
        y: display.workArea.y,
        width: display.workArea.width,
        height: display.workArea.height
      })
    )
    .map((display) => display.id)
  const hasSecondaryDisplay = params.displays.some(
    (display) => display.id !== params.primaryDisplayId
  )

  if (params.policy.preferSecondaryDisplay && hasSecondaryDisplay) {
    const intersectsPrimaryDisplay = intersectingDisplayIds.includes(params.primaryDisplayId)
    const intersectsSecondaryDisplay = intersectingDisplayIds.some(
      (displayId) => displayId !== params.primaryDisplayId
    )
    return {
      intersectingDisplayIds,
      expectedMode: 'secondary-display',
      shouldHideWindow: intersectsPrimaryDisplay || !intersectsSecondaryDisplay
    }
  }

  if (params.policy.forceOffscreen) {
    return {
      intersectingDisplayIds,
      expectedMode: 'offscreen',
      shouldHideWindow: intersectingDisplayIds.length > 0
    }
  }

  if (params.policy.preferSecondaryDisplay) {
    return {
      intersectingDisplayIds,
      expectedMode: 'offscreen',
      shouldHideWindow: intersectingDisplayIds.length > 0
    }
  }

  return {
    intersectingDisplayIds,
    expectedMode: 'none',
    shouldHideWindow: false
  }
}

export function resolveTestArtifactRoot(params: {
  desktopPath: string
  tempPath: string
  policy: Pick<TestUiPolicy, 'automatedRun' | 'runId' | 'artifactRootOverride'>
}): string {
  if (!params.policy.automatedRun) {
    return params.tempPath
  }

  const artifactBasePath = resolveDefaultArtifactBasePath()
  const normalizedArtifactRoot = joinWithPathStyle(
    artifactBasePath,
    TEST_UI_ARTIFACT_ROOT_DIR,
    sanitizeTestUiRunId(params.policy.runId)
  )

  const overrideValue = normalizeTrimmed(params.policy.artifactRootOverride)
  if (overrideValue) {
    const overridePathModule = getPathModuleForValue(normalizedArtifactRoot, overrideValue)
    const absoluteOverride = overridePathModule.isAbsolute(overrideValue)
    const overrideCandidate = absoluteOverride
      ? overridePathModule.resolve(overrideValue)
      : overridePathModule.resolve(normalizedArtifactRoot, overrideValue)

    if (isInsideDirectory(overrideCandidate, normalizedArtifactRoot)) {
      logTestUiPolicyDecision('artifact-root', {
        reason: 'override-accepted',
        artifactRoot: normalizedArtifactRoot,
        override: overrideCandidate
      })
      return overrideCandidate
    }

    logTestUiPolicyDecision('artifact-root', {
      reason: 'override-out-of-bound',
      artifactRoot: normalizedArtifactRoot,
      override: overrideCandidate
    })
  }

  return normalizedArtifactRoot
}

export function resolveTestArtifactPath(params: ResolveTestArtifactPathParams): string {
  const root = resolveTestArtifactRoot({
    desktopPath: params.desktopPath,
    tempPath: params.tempPath,
    policy: params.policy
  })
  const safeSegments = sanitizeArtifactSegments(params.segments)
  const artifactPath = joinWithPathStyle(root, ...safeSegments)

  logTestUiPolicyDecision('artifact-path', {
    root,
    segments: safeSegments,
    artifactPath
  })

  return artifactPath
}
