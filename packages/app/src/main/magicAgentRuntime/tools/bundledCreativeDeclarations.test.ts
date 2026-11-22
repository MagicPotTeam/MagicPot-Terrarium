import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { bundledCreativeDeclarations } from '@shared/magicAgentRuntime/bundledCreativeDeclarations'
import { createMagicAgentCreativeToolRegistry } from './registry'
import type { MagicAgentCreativeToolDependencies } from './types'

// Literal hashes of full untouched contextless definitions, captured before extraction.
// Fixture: .magicpot-trash/studio-bundled-declarations-baseline.json SHA256
// 56102e8ab38d8e44c2b8753104a62eeb9dbbee7cd037dd2c98f5fbaf3d892534.
const original = [
  ['comfyui.status', 'comfyStatus', '2c1b36008386b52b0aea7d3cd1567fdab0e044b5f3e45b6b6490e457a1be6eda'],
  ['comfyui.queue', 'comfyQueue', '2697a3e48c2c6842c373a989d88863f51a08f411edbbb6941eaeadbf0ccc4418'],
  ['comfyui.workflow.submit', 'comfySubmitWorkflow', '73899d38ea1213fd5cc0781351b28dabd98e5810c0ce75fb64b44818ca2b2ddf'],
  ['qapp.list', 'qappList', '0cbe86373ef01bd78ee3d67af562855e32bdcb47c6c4ee34cecbdac1ae59d01a'],
  ['qapp.get', 'qappGet', '0f5162b88ce8f9ff7a398094a2c44e54c2198f9ef10b92b38b734c72d156a37c'],
  ['canvas.status', 'canvasStatus', '436d76a1375469576496d0d9c5ddd526949614f49c7774413c3d018fb58fee2b'],
  ['canvas.export', 'canvasExport', '8d7383783c9ad4b89e89568e1df4077397af1092054d4f88d656480a0e92b729'],
  ['image.inspect', 'imageInspect', 'e2ce03c82d6639bb406db38495fe4562a6899bceb704641dbe919aa94ed3f3fc'],
  ['image.create', 'imageCreate', '76a18b3f6cbf308b7d3a07637896c0e16b51404a630bf3cc17933e5c8a4110a5'],
  ['video.inspect', 'videoInspect', 'e99e7f92b8d62809020f9c31d72281a7aeab76270f7cfadd5683117b810e434e'],
  ['video.create', 'videoCreate', '312facd529b92ef7c002a062f94474038faff9116ee16fcde9dac197fb2d6607'],
  ['model.list', 'modelList', '01d398ade8300c792ebbaf252c9dcfa8c5c089b499857c9445310f4c68ce6c6a'],
  ['model.inspect', 'modelInspect', '837e974721f5bb539fadec4d7def8d9ba46cca1431f84e4e715ab359cd299ad2'],
  ['model.status', 'modelStatus', '339024e177e8a76c478a3445fe184803c0fad997f3a7c7498b3c17c9b462f492'],
  ['asset.list', 'assetList', 'eda92f5d3094f61e8e2661db4c1267515832c1ea3e4c486f9b8ee8355df0b3cf'],
  ['asset.import', 'assetImport', 'e968376974ad4fa1299917866c791b545c8ede34d62526c0b6fa0111ec596417'],
  ['project.trace.list', 'projectTraceList', '9a0755ce3c77242ccdefbd62a8a516934612d3aeb0a76f53368889197ce8dfa0'],
  ['project.trace.read', 'projectTraceRead', '1339a64ae5ad54d2cb3215eeadb7e2ef45aa3227796e1afd34ff202f0f01f03d'],
  ['mcp.status', 'mcpStatus', '7b1d7f8f4f646fdb73b3cc66142e15f3197e916a230cefbf83fd527574b30b8d'],
  ['mcp.tool.call', 'mcpCallTool', '12bb49de2297814fc0276f95ea38a154b206647492e3443e5a334a55c4078861'],
  ['terminal.run', 'terminalRun', 'e3310290c5bfb46d82f525f22612e86bc473a0fa5c800d4e6f75cf5bac86202e']
] as const
const registry = createMagicAgentCreativeToolRegistry()
const definitions = registry.listTools()

describe('bundled declarations preserve the real default creative adapter contract', () => {
  it('retains exact ordered complete definitions including nested schemas and approval flags', () => {
    expect(definitions.map(row => row.name)).toEqual(original.map(row => row[0]))
    for (const [index, [, , digest]] of original.entries()) expect(createHash('sha256').update(JSON.stringify(definitions[index])).digest('hex')).toBe(digest)
  })
  it.each(original)('uses the same shared public metadata for %s (%s)', (name, _dependency, _digest) => {
    const row = definitions.find(item => item.name === name)!
    expect(bundledCreativeDeclarations[name]).toEqual({ name: row.name, category: row.category, description: row.description })
    expect(Object.isFrozen(bundledCreativeDeclarations[name])).toBe(true)
  })
  it.each(original)('preserves dependency dispatch and approval for %s (%s)', async (name, dependency, _digest) => {
    const call = vi.fn(async (_args: Record<string, unknown>) => ({ marker: name })), authorizeMutation = vi.fn(async () => {})
    const args = { nested: { exact: name } }
    const deps = { [dependency]: call } as Partial<MagicAgentCreativeToolDependencies>
    const row = definitions.find(item => item.name === name)!
    const mutating = row.permissionLevel !== 'read' || row.requiresConfirmation || row.disabledByDefault
    if (mutating) {
      const denied = await registry.dispatch(name, args, { dependencies: deps })
      expect(denied.permissionDenied).toBe(true); expect(call).not.toHaveBeenCalled()
    }
    const result = await registry.dispatch(name, args, { dependencies: deps, authorizeMutation })
    expect(result).toMatchObject({ ok: true, toolName: name, data: { marker: name } })
    expect(call).toHaveBeenCalledTimes(1); expect(call.mock.calls[0]?.[0]).toEqual(args)
    expect(authorizeMutation).toHaveBeenCalledTimes(mutating ? 1 : 0)
  })
  it('does not turn declaration mutation into authority or alter later runtime definitions', () => {
    const row = bundledCreativeDeclarations['terminal.run']
    expect(row).toBeDefined(); expect(Reflect.set(row, 'permissionLevel', 'read')).toBe(false)
    expect(registry.listTools().find(item => item.name === 'terminal.run')).toMatchObject({ permissionLevel: 'destructive', requiresConfirmation: true, disabledByDefault: true, status: 'unavailable' })
  })
})
