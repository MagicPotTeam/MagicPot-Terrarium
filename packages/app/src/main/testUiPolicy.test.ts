import { win32 as pathWin32 } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assessTestWindowPlacement,
  createTestUiRunId,
  readTestUiEnv,
  resolveConfiguredDesktopPath,
  sanitizeTestUiRunId,
  resolveTestArtifactPath,
  resolveTestArtifactRoot,
  resolveTestUiPolicy,
  resolveTestWindowOverride,
  resolveTestWindowPlacement
} from './testUiPolicy'

describe('testUiPolicy env contract', () => {
  it('parses the compatibility aliases and automated-run flags', () => {
    const env = readTestUiEnv({
      MAGICPOT_TEST_WINDOW_MODE: 'hidden',
      MAGICPOT_TEST_NO_FOCUS: '1',
      RUN_ELECTRON_STARTUP_SMOKE: '1',
      MAGICPOT_TEST_RUN_ID: 'run-123',
      MAGICPOT_TEST_ARTIFACT_ROOT: 'C:/Repo/.magicpot-trash/run-123'
    })

    expect(env).toEqual({
      windowMode: 'hidden',
      noFocus: true,
      automatedRun: true,
      runId: 'run-123',
      artifactRootOverride: 'C:/Repo/.magicpot-trash/run-123'
    })
  })
})

describe('resolveTestUiPolicy', () => {
  it('defaults automated runs to secondary-or-offscreen and inactive show behavior', () => {
    expect(
      resolveTestUiPolicy(
        {
          windowMode: undefined,
          noFocus: true,
          automatedRun: true,
          runId: 'run-123'
        },
        { now: 123, pid: 456 }
      )
    ).toEqual({
      automatedRun: true,
      windowMode: 'secondary-or-offscreen',
      noFocus: true,
      hideWindow: false,
      preferSecondaryDisplay: true,
      forceOffscreen: false,
      suppressTaskbar: true,
      showBehavior: 'show-inactive',
      runId: 'run-123',
      artifactRootOverride: undefined
    })
  })

  it('implies no-focus for automated runs even when the env flag is omitted', () => {
    expect(
      resolveTestUiPolicy(
        {
          windowMode: undefined,
          noFocus: false,
          automatedRun: true,
          runId: 'run-123'
        },
        { now: 123, pid: 456 }
      )
    ).toMatchObject({
      automatedRun: true,
      windowMode: 'secondary-or-offscreen',
      noFocus: true,
      showBehavior: 'show-inactive'
    })
  })

  it('generates a run id when one is not provided', () => {
    expect(
      resolveTestUiPolicy(
        {
          windowMode: 'offscreen',
          noFocus: false,
          automatedRun: true
        },
        { now: 1712345678901, pid: 42 }
      ).runId
    ).toBe(createTestUiRunId(1712345678901, 42))
  })

  it('sanitizes run ids before using them for automated artifact roots', () => {
    expect(
      resolveTestUiPolicy(
        {
          windowMode: 'offscreen',
          noFocus: false,
          automatedRun: true,
          runId: '../../desktop takeover'
        },
        { now: 123, pid: 456 }
      ).runId
    ).toBe('desktop-takeover')
  })
})

describe('sanitizeTestUiRunId', () => {
  it('collapses separators and path traversal into a safe single path segment', () => {
    expect(sanitizeTestUiRunId('../..\\bad/run id')).toBe('bad-run-id')
  })

  it('falls back when sanitization would otherwise produce an empty run id', () => {
    expect(sanitizeTestUiRunId('////', 'run-safe')).toBe('run-safe')
  })
})

describe('resolveTestWindowPlacement', () => {
  it('prefers a secondary display for secondary-or-offscreen windows', () => {
    expect(
      resolveTestWindowPlacement({
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
          forceOffscreen: true
        }
      })
    ).toEqual({
      x: 2600,
      y: 320
    })
  })

  it('moves windows outside the union of all visible displays when forced offscreen', () => {
    expect(
      resolveTestWindowPlacement({
        width: 800,
        height: 600,
        displays: [
          { id: 1, workArea: { x: -1600, y: 0, width: 1600, height: 900 } },
          { id: 2, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
        ],
        primaryDisplayId: 2,
        policy: {
          hideWindow: false,
          preferSecondaryDisplay: false,
          forceOffscreen: true
        }
      })
    ).toEqual({
      x: 2040,
      y: 120
    })
  })

  it('falls back to an off-screen placement when no secondary display is available', () => {
    expect(
      resolveTestWindowPlacement({
        width: 900,
        height: 600,
        displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
        primaryDisplayId: 1,
        policy: {
          hideWindow: false,
          preferSecondaryDisplay: true,
          forceOffscreen: false
        }
      })
    ).toEqual({
      x: 2040,
      y: 120
    })
  })

  it('returns null for hidden windows', () => {
    expect(
      resolveTestWindowPlacement({
        width: 800,
        height: 600,
        displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
        primaryDisplayId: 1,
        policy: {
          hideWindow: true,
          preferSecondaryDisplay: false,
          forceOffscreen: false
        }
      })
    ).toBeNull()
  })
})

describe('assessTestWindowPlacement', () => {
  it('accepts windows that are fully placed on a secondary display', () => {
    expect(
      assessTestWindowPlacement({
        bounds: { x: 2600, y: 320, width: 1200, height: 800 },
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
    ).toEqual({
      intersectingDisplayIds: [2],
      expectedMode: 'secondary-display',
      shouldHideWindow: false
    })
  })

  it('forces a hidden fallback when an automated window remains visible on the primary display', () => {
    expect(
      assessTestWindowPlacement({
        bounds: { x: 100, y: 100, width: 1200, height: 800 },
        displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
        primaryDisplayId: 1,
        policy: {
          hideWindow: false,
          preferSecondaryDisplay: true,
          forceOffscreen: true
        }
      })
    ).toEqual({
      intersectingDisplayIds: [1],
      expectedMode: 'offscreen',
      shouldHideWindow: true
    })
  })

  it('flags visible windows when the policy explicitly forces offscreen placement', () => {
    expect(
      assessTestWindowPlacement({
        bounds: { x: 2100, y: 100, width: 600, height: 800 },
        displays: [
          { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
          { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } }
        ],
        primaryDisplayId: 1,
        policy: {
          hideWindow: false,
          preferSecondaryDisplay: false,
          forceOffscreen: true
        }
      })
    ).toEqual({
      intersectingDisplayIds: [2],
      expectedMode: 'offscreen',
      shouldHideWindow: true
    })
  })
})

describe('resolveConfiguredDesktopPath', () => {
  it('honors an explicit automated desktop override when provided', () => {
    expect(
      resolveConfiguredDesktopPath('C:/Users/test/Desktop', {
        MAGICPOT_TEST_DESKTOP_PATH: 'D:/Redirected/Desktop'
      })
    ).toBe('D:/Redirected/Desktop')
  })

  it('falls back to the detected desktop path when no override is provided', () => {
    expect(resolveConfiguredDesktopPath('C:/Users/test/Desktop', {})).toBe('C:/Users/test/Desktop')
  })
})

describe('resolveTestWindowOverride', () => {
  it('ignores manual test-window overrides during automated runs', () => {
    expect(
      resolveTestWindowOverride({
        x: 120,
        y: 240,
        policy: {
          automatedRun: true
        }
      })
    ).toBeNull()
  })

  it('accepts manual test-window overrides outside automated runs', () => {
    expect(
      resolveTestWindowOverride({
        x: 120.8,
        y: 240.2,
        policy: {
          automatedRun: false
        }
      })
    ).toEqual({
      x: 120,
      y: 240
    })
  })
})

describe('resolveTestArtifactPath', () => {
  const previousArtifactBase = process.env.MAGICPOT_TEST_ARTIFACT_BASE

  beforeEach(() => {
    process.env.MAGICPOT_TEST_ARTIFACT_BASE = 'C:/Users/test/MagicPot'
  })

  afterEach(() => {
    if (previousArtifactBase === undefined) {
      delete process.env.MAGICPOT_TEST_ARTIFACT_BASE
    } else {
      process.env.MAGICPOT_TEST_ARTIFACT_BASE = previousArtifactBase
    }
  })

  it('routes disposable artifacts into repo .magicpot-trash/<run-id>', () => {
    expect(
      resolveTestArtifactRoot({
        desktopPath: 'C:/Users/test/Desktop',
        tempPath: 'C:/Temp',
        policy: {
          automatedRun: true,
          runId: 'run-123',
          artifactRootOverride: undefined
        }
      })
    ).toBe(pathWin32.join('C:/Users/test/MagicPot', '.magicpot-trash', 'run-123'))

    expect(
      resolveTestArtifactPath({
        desktopPath: 'C:/Users/test/Desktop',
        tempPath: 'C:/Temp',
        policy: {
          automatedRun: true,
          runId: 'run-123',
          artifactRootOverride: undefined
        },
        segments: ['traces', 'window.json']
      })
    ).toBe(
      pathWin32.join(
        'C:/Users/test/MagicPot',
        '.magicpot-trash',
        'run-123',
        'traces',
        'window.json'
      )
    )
  })

  it('falls back to the system temp directory outside automated runs', () => {
    expect(
      resolveTestArtifactRoot({
        desktopPath: 'C:/Users/test/Desktop',
        tempPath: 'C:/Temp',
        policy: {
          automatedRun: false,
          runId: 'run-123',
          artifactRootOverride: undefined
        }
      })
    ).toBe('C:/Temp')
  })

  it('rejects automated artifact overrides outside the repo trash root', () => {
    expect(
      resolveTestArtifactRoot({
        desktopPath: 'C:/Users/test/Desktop',
        tempPath: 'C:/Temp',
        policy: {
          automatedRun: true,
          runId: 'run-123',
          artifactRootOverride: 'D:/scratch/outside-root'
        }
      })
    ).toBe(pathWin32.join('C:/Users/test/MagicPot', '.magicpot-trash', 'run-123'))
  })

  it('treats Windows absolute override paths consistently on non-Windows hosts', async () => {
    vi.resetModules()
    vi.doMock('path', async () => {
      const actual = await vi.importActual<typeof import('path')>('path')
      return {
        ...actual,
        isAbsolute: () => false
      }
    })

    try {
      const { resolveTestArtifactRoot: resolveTestArtifactRootWithMockedPath } =
        await import('./testUiPolicy')

      expect(
        resolveTestArtifactRootWithMockedPath({
          desktopPath: 'C:/Users/test/Desktop',
          tempPath: 'C:/Temp',
          policy: {
            automatedRun: true,
            runId: 'run-123',
            artifactRootOverride: 'D:/scratch/outside-root'
          }
        })
      ).toBe(pathWin32.join('C:/Users/test/MagicPot', '.magicpot-trash', 'run-123'))
    } finally {
      vi.doUnmock('path')
      vi.resetModules()
    }
  })

  it('sanitizes the automated run id before composing the trash root', () => {
    expect(
      resolveTestArtifactRoot({
        desktopPath: 'C:/Users/test/Desktop',
        tempPath: 'C:/Temp',
        policy: {
          automatedRun: true,
          runId: '../../desktop takeover',
          artifactRootOverride: undefined
        }
      })
    ).toBe(pathWin32.join('C:/Users/test/MagicPot', '.magicpot-trash', 'desktop-takeover'))
  })

  it('allows automated artifact overrides only inside the repo trash root', () => {
    expect(
      resolveTestArtifactRoot({
        desktopPath: 'C:/Users/test/Desktop',
        tempPath: 'C:/Temp',
        policy: {
          automatedRun: true,
          runId: 'run-123',
          artifactRootOverride: 'nested/debug'
        }
      })
    ).toBe(
      pathWin32.join('C:/Users/test/MagicPot', '.magicpot-trash', 'run-123', 'nested', 'debug')
    )
  })

  it('sanitizes artifact path segments before joining them', () => {
    expect(
      resolveTestArtifactPath({
        desktopPath: 'C:/Users/test/Desktop',
        tempPath: 'C:/Temp',
        policy: {
          automatedRun: true,
          runId: 'run-123',
          artifactRootOverride: undefined
        },
        segments: ['traces', '../unsafe', '.\\nested//leaf', '..', 'window.json']
      })
    ).toBe(
      pathWin32.join(
        'C:/Users/test/MagicPot',
        '.magicpot-trash',
        'run-123',
        'traces',
        'unsafe',
        'nested',
        'leaf',
        'window.json'
      )
    )
  })
})
