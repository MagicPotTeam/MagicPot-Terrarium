import { describe, expect, it } from 'vitest'
import type { SkillRuntimeSpec } from './chatSkillRuntime'
import {
  buildSkillRuntimePreScriptContext,
  resolveSkillRuntimePreScripts,
  runSkillRuntimePreScripts,
  buildSkillRuntimePostScriptContext,
  resolveSkillRuntimePostScripts,
  runSkillRuntimePostScripts
} from './chatSkillRuntimeScripts'

describe('chatSkillRuntimeScripts', () => {
  it('applies minimal pre-run hooks in declared order', () => {
    const runtime: SkillRuntimeSpec = {
      skill: null,
      instructions: {},
      execution: {
        mode: 'isolated',
        allowHistory: false,
        outputMode: 'chat',
        fallbackStrategy: 'default',
        persistSessionUrl: false
      },
      resources: [],
      scripts: ['pre:trim-text', 'pre:strip-markdown-fences'],
      boundApps: [],
      boundBindings: [],
      unavailableBindings: []
    }

    const report = resolveSkillRuntimePreScripts({
      runtime,
      content: '  ```text\ntrim me\n```  '
    })

    expect(report.phase).toBe('pre')
    expect(report.content).toBe('trim me')
    expect(report.steps).toEqual([
      expect.objectContaining({
        script: 'pre:trim-text',
        phase: 'pre',
        supported: true,
        changed: true
      }),
      expect.objectContaining({
        script: 'pre:strip-markdown-fences',
        phase: 'pre',
        supported: true,
        changed: true
      })
    ])
    expect(buildSkillRuntimePreScriptContext(runtime, report)).toContain(
      'Skill pre scripts (supported=2, unsupported=0):'
    )
    expect(runSkillRuntimePreScripts({ runtime, content: '  keep me  ' })).toBe('keep me')
  })

  it('applies minimal post-run hooks in declared order', () => {
    const runtime: SkillRuntimeSpec = {
      skill: null,
      instructions: {},
      execution: {
        mode: 'isolated',
        allowHistory: false,
        outputMode: 'chat',
        fallbackStrategy: 'default',
        persistSessionUrl: false
      },
      resources: [],
      scripts: ['post:strip-markdown-fences', 'post:trim-text'],
      boundApps: [],
      boundBindings: [],
      unavailableBindings: []
    }

    const report = resolveSkillRuntimePostScripts({
      runtime,
      content: '```markdown\n  translated text  \n```'
    })

    expect(report.content).toBe('translated text')
    expect(report.phase).toBe('post')
    expect(report.steps).toEqual([
      expect.objectContaining({
        script: 'post:strip-markdown-fences',
        phase: 'post',
        supported: true,
        changed: true
      }),
      expect.objectContaining({
        script: 'post:trim-text',
        phase: 'post',
        supported: true,
        changed: false
      })
    ])
    expect(buildSkillRuntimePostScriptContext(runtime, report)).toContain(
      'Skill post scripts (supported=2, unsupported=0):'
    )
  })

  it('reports unsupported post scripts without mutating the content contract', () => {
    const runtime: SkillRuntimeSpec = {
      skill: null,
      instructions: {},
      execution: {
        mode: 'isolated',
        allowHistory: false,
        outputMode: 'chat',
        fallbackStrategy: 'default',
        persistSessionUrl: false
      },
      resources: [],
      scripts: ['post:trim-text', 'post:custom-step'],
      boundApps: [],
      boundBindings: [],
      unavailableBindings: []
    }

    const report = resolveSkillRuntimePostScripts({
      runtime,
      content: '  keep me  '
    })

    expect(report.content).toBe('keep me')
    expect(report.steps).toEqual([
      expect.objectContaining({
        script: 'post:trim-text',
        phase: 'post',
        supported: true,
        changed: true
      }),
      expect.objectContaining({
        script: 'post:custom-step',
        phase: 'post',
        supported: false,
        note: 'Unsupported post script; skipped.'
      })
    ])
    expect(buildSkillRuntimePostScriptContext(runtime, report)).toContain(
      'Skill post scripts (supported=1, unsupported=1):'
    )
    expect(runSkillRuntimePostScripts({ runtime, content: '  keep me  ' })).toBe('keep me')
  })
})
