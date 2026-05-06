/* eslint-disable @typescript-eslint/explicit-function-return-type */
import fs from 'node:fs'
import path from 'node:path'

const SAFE_RUN_ID_PATTERN = /[^a-zA-Z0-9_-]+/g
const TEST_ARTIFACT_ROOT_DIR = '.magicpot-trash'

function createDefaultRunId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function resolveBenchmarkDesktopPath() {
  const configuredDesktopPath = `${process.env.MAGICPOT_TEST_DESKTOP_PATH ?? ''}`.trim()
  if (configuredDesktopPath) {
    return configuredDesktopPath
  }

  const cwd = process.cwd()
  const possiblePrivateRepoRoot = path.resolve(cwd, '..', '..')
  if (
    path.basename(path.dirname(cwd)) === 'open' &&
    fs.existsSync(path.join(possiblePrivateRepoRoot, 'private', 'codex'))
  ) {
    return possiblePrivateRepoRoot
  }

  return cwd
}

export function resolveProjectCanvasBenchmarkDesktopPath() {
  return resolveBenchmarkDesktopPath()
}

function normalizeTrimmed(value) {
  const trimmed = `${value ?? ''}`.trim()
  return trimmed || undefined
}

function isInsideDirectory(candidatePath, parentPath) {
  const normalizedParent = path.resolve(parentPath)
  const normalizedCandidate = path.resolve(candidatePath)
  const relation = path.relative(normalizedParent, normalizedCandidate)
  return relation === '' || (!relation.startsWith('..') && !path.isAbsolute(relation))
}

function rectanglesIntersect(left, right) {
  const leftRight = left.x + left.width
  const leftBottom = left.y + left.height
  const rightRight = right.x + right.width
  const rightBottom = right.y + right.height

  return left.x < rightRight && leftRight > right.x && left.y < rightBottom && leftBottom > right.y
}

export function sanitizeProjectCanvasRunId(value, fallback = 'project-canvas-benchmark') {
  const normalized = `${value ?? ''}`.trim()
  const sanitized = normalized
    .replace(/[/\\]+/g, '-')
    .replace(SAFE_RUN_ID_PATTERN, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  return sanitized || fallback
}

export function resolveProjectCanvasBenchmarkRunId(prefix) {
  return sanitizeProjectCanvasRunId(process.env.MAGICPOT_TEST_RUN_ID, createDefaultRunId(prefix))
}

export function buildNonIntrusiveTestWindowEnv(runId) {
  const safeRunId = sanitizeProjectCanvasRunId(runId)
  const artifactRootOverride = resolveProjectCanvasArtifactRootOverride(safeRunId)
  return {
    MAGICPOT_TEST_UI_MODE: 'secondary-or-offscreen',
    MAGICPOT_TEST_WINDOW_MODE: 'secondary-or-offscreen',
    MAGICPOT_TEST_NO_FOCUS: '1',
    MAGICPOT_TEST_AUTOMATED_RUN: '1',
    MAGICPOT_TEST_RUN_ID: safeRunId,
    ...(artifactRootOverride ? { MAGICPOT_TEST_ARTIFACT_ROOT: artifactRootOverride } : {})
  }
}

function resolveDefaultProjectCanvasArtifactRoot(runId) {
  return path.join(
    resolveProjectCanvasBenchmarkDesktopPath(),
    TEST_ARTIFACT_ROOT_DIR,
    sanitizeProjectCanvasRunId(runId)
  )
}

export function resolveProjectCanvasArtifactRootOverride(runId) {
  const defaultRoot = resolveDefaultProjectCanvasArtifactRoot(runId)
  const overrideValue =
    normalizeTrimmed(process.env.MAGICPOT_TEST_ARTIFACT_ROOT) ||
    normalizeTrimmed(process.env.MAGICPOT_TEST_UI_ARTIFACT_ROOT)

  if (!overrideValue) {
    return undefined
  }

  const overrideCandidate = path.isAbsolute(overrideValue)
    ? path.resolve(overrideValue)
    : path.resolve(defaultRoot, overrideValue)

  return isInsideDirectory(overrideCandidate, defaultRoot) ? overrideCandidate : undefined
}

export function resolveProjectCanvasArtifactRoot(runId) {
  return (
    resolveProjectCanvasArtifactRootOverride(runId) ||
    resolveDefaultProjectCanvasArtifactRoot(runId)
  )
}

export function assessNonIntrusiveWindowPlacement(placement) {
  const intersectingDisplayIds = placement.displays
    .filter((display) =>
      rectanglesIntersect(placement.bounds, {
        x: display.workArea.x,
        y: display.workArea.y,
        width: display.workArea.width,
        height: display.workArea.height
      })
    )
    .map((display) => display.id)
  const hasSecondaryDisplay = placement.displays.some(
    (display) => display.id !== placement.primaryDisplayId
  )
  const intersectsPrimaryDisplay = intersectingDisplayIds.includes(placement.primaryDisplayId)
  const intersectsSecondaryDisplay = intersectingDisplayIds.some(
    (displayId) => displayId !== placement.primaryDisplayId
  )
  const isNonIntrusive = !placement.visible
    ? true
    : hasSecondaryDisplay
      ? !intersectsPrimaryDisplay && intersectsSecondaryDisplay
      : intersectingDisplayIds.length === 0

  return {
    hasSecondaryDisplay,
    intersectingDisplayIds,
    intersectsPrimaryDisplay,
    intersectsSecondaryDisplay,
    isNonIntrusive
  }
}

export function assertNonIntrusiveWindowPlacement(placement, label) {
  if (placement.visible !== true && placement.visible !== false) {
    throw new Error(`${label} must report whether the benchmark window is visible.`)
  }
  if (placement.focusable !== false) {
    throw new Error(`${label} should not allow the benchmark window to take focus.`)
  }
  if (placement.focused !== false) {
    throw new Error(`${label} unexpectedly focused the benchmark window.`)
  }
  if (placement.skipTaskbar !== true) {
    throw new Error(`${label} should keep benchmark windows off the taskbar.`)
  }

  const assessment = assessNonIntrusiveWindowPlacement(placement)

  if (!assessment.isNonIntrusive) {
    const modeDescription = assessment.hasSecondaryDisplay
      ? 'fully on a secondary display'
      : 'fully off-screen when only the primary display exists'
    throw new Error(
      `${label} must remain ${modeDescription}; bounds=${JSON.stringify(placement.bounds)} intersections=${assessment.intersectingDisplayIds.join(',') || 'none'}`
    )
  }

  return assessment
}
