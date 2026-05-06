import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildAgentPaneScope,
  buildCanvasAgentRoute,
  clampStageScale,
  getCanvasAgentSessionKey,
  resolveActiveAgentPaneId,
  resolveActiveAgentScope,
  resolveActiveCanvasAgentSessionKey,
  resolveCanvasAgentPaneIdFromScope,
  resolveCanvasAgentSessionKeyForScope
} from './canvasPageLocalStateUtils'
import {
  PROJECT_CANVAS_MAX_STAGE_SCALE,
  PROJECT_CANVAS_MIN_STAGE_SCALE,
  formatProjectCanvasScalePercent
} from './projectCanvasViewportScale'

describe('canvasPageLocalStateUtils', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('builds and resolves the active pane scope from shared workspace storage', () => {
    localStorage.setItem('agent.workspace.active.canvas-1', 'agent-2')

    expect(resolveActiveAgentPaneId('canvas-1')).toBe('agent-2')
    expect(buildAgentPaneScope('canvas-1', 'agent-2')).toBe('canvas-1.agent-2')
    expect(resolveActiveAgentScope('canvas-1')).toBe('canvas-1.agent-2')
  })

  it('derives a canonical canvas agent route and session key', () => {
    const route = buildCanvasAgentRoute('canvas-1', 'agent-3')

    expect(route).toEqual({
      channel: 'canvas',
      scopeType: 'thread',
      scopeId: 'canvas-1',
      threadId: 'agent-3'
    })
    expect(getCanvasAgentSessionKey('canvas-1', 'agent-3')).toBe(
      'canvas:thread:canvas-1:thread:agent-3'
    )
  })

  it('resolves a session key from a matching pane scope only', () => {
    localStorage.setItem('agent.workspace.active.canvas-1', 'agent-4')

    expect(resolveActiveCanvasAgentSessionKey('canvas-1')).toBe(
      'canvas:thread:canvas-1:thread:agent-4'
    )
    expect(resolveCanvasAgentPaneIdFromScope('canvas-1', 'canvas-1.agent-9')).toBe('agent-9')
    expect(resolveCanvasAgentSessionKeyForScope('canvas-1', 'canvas-1.agent-9')).toBe(
      'canvas:thread:canvas-1:thread:agent-9'
    )
    expect(resolveCanvasAgentPaneIdFromScope('canvas-1', 'selection-1')).toBeUndefined()
    expect(resolveCanvasAgentSessionKeyForScope('canvas-1', 'selection-1')).toBeUndefined()
  })

  it('allows overview zoom below one percent while retaining a finite floor', () => {
    expect(clampStageScale(0)).toBe(PROJECT_CANVAS_MIN_STAGE_SCALE)
    expect(clampStageScale(0.00005)).toBe(PROJECT_CANVAS_MIN_STAGE_SCALE)
    expect(clampStageScale(0.0005)).toBe(0.0005)
    expect(clampStageScale(80)).toBe(80)
    expect(clampStageScale(800)).toBe(PROJECT_CANVAS_MAX_STAGE_SCALE)
    expect(clampStageScale(3, 2)).toBe(2)
  })

  it('formats sub-one-percent zoom without rounding it back to one percent', () => {
    expect(formatProjectCanvasScalePercent(PROJECT_CANVAS_MIN_STAGE_SCALE)).toBe('0.01')
    expect(formatProjectCanvasScalePercent(0.0025)).toBe('0.25')
    expect(formatProjectCanvasScalePercent(0.008)).toBe('0.8')
    expect(formatProjectCanvasScalePercent(0.01)).toBe('1')
    expect(formatProjectCanvasScalePercent(0.145)).toBe('14')
    expect(formatProjectCanvasScalePercent(PROJECT_CANVAS_MAX_STAGE_SCALE)).toBe('50000')
  })
})
