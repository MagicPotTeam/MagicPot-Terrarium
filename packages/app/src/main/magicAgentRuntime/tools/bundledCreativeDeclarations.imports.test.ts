import { describe, expect, it, vi } from 'vitest'
import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'
import { createMagicAgentCreativeToolRegistry } from './registry'

// Count module evaluation and calls; do not reset before the cold-import assertion.
const h = vi.hoisted(() => ({ imports: [] as string[], calls: vi.fn(() => undefined) }))
vi.mock('node:fs', () => { h.imports.push('fs'); return { default: { readFileSync: h.calls, writeFileSync: h.calls }, readFileSync: h.calls, writeFileSync: h.calls } })
vi.mock('node:fs/promises', () => { h.imports.push('fsp'); return { default: { readFile: h.calls, writeFile: h.calls }, readFile: h.calls, writeFile: h.calls } })
vi.mock('node:child_process', () => { h.imports.push('process'); return { spawn: h.calls, exec: h.calls } })
vi.mock('electron', () => { h.imports.push('electron'); return { app: { getPath: h.calls } } })
vi.mock('../../config/config', () => { h.imports.push('config'); return { getConfig: h.calls, initConfig: h.calls } })
vi.mock('../platformAdapter', () => { h.imports.push('platform'); return { getMagicAgentPlatformAdapter: h.calls, createMagicAgentPlatformAdapter: h.calls } })
vi.mock('../productionCreativeDependencies', () => { h.imports.push('dependencies'); return { createProductionCreativeToolDependencies: h.calls } })
vi.mock('../../api/svcLLMProxyImpl', () => { h.imports.push('provider'); return { LLMProxySvcImpl: h.calls } })
vi.mock('../../agentKernel', () => { h.imports.push('kernel'); return { getAgentKernel: h.calls } })

describe('bounded declaration import and contextless enumeration firebreaks', () => {
  it('imports shared metadata and actual creative adapters without touching enumerated runtime/IO/probe owners', () => {
    expect(h.imports).toEqual([]); expect(h.calls).not.toHaveBeenCalled()
    const rows = createMagicAgentCreativeToolRegistry().listTools()
    expect(rows).toHaveLength(21)
    expect(rows.map(row => ({ name: row.name, category: row.category, description: row.description }))).toEqual(Object.values(bundledCreativeDeclarations))
    expect(rows.every(row => row.status === 'unavailable')).toBe(true)
    expect(h.imports).toEqual([]); expect(h.calls).not.toHaveBeenCalled()
  })
})
