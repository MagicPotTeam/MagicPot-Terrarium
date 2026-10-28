import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiDef } from '@shared/api'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding,
  unregisterMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import {
  ServiceValidationError,
  withServiceValidation
} from '@shared/api/apiUtils/serviceValidation'
import { FigPluginCenterOperationSchema } from '@shared/figplugin/center'
import { FigPluginCenterStore } from '../figplugin/centerStore'
import { FigPluginCenterSvcImpl } from './svcFigPluginCenterImpl'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const { getPath } = vi.hoisted(() => ({ getPath: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath } }))

let userData: string
const statusRequest = FigPluginCenterOperationSchema.parse({
  schemaVersion: 1,
  kind: 'status',
  requestId: 'status-request',
  idempotencyKey: 'status-idempotency',
  requestedAt: '2026-01-01T00:00:00.000Z',
  pluginId: 'demo',
  host: 'figma'
})
beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(process.cwd(), '.figplugin-service-test-'))
  getPath.mockReset().mockReturnValue(userData)
  clearMagicAgentTrustedRouteBindingsForTest()
})
afterEach(async () => {
  vi.restoreAllMocks()
  clearMagicAgentTrustedRouteBindingsForTest()
  await fs.rm(userData, { recursive: true, force: true })
})

describe('FigPluginCenterSvcImpl', () => {
  it('is a normal validated core API and lazily uses only userData/figplugin-center', async () => {
    const service = new FigPluginCenterSvcImpl()
    expect(getPath).not.toHaveBeenCalled()
    const definition = apiDef.svcFigPluginCenter.execute
    expect(definition.type).toBe('unary')
    expect(definition.request).toBeDefined()
    expect(definition.response).toBeDefined()
    const execute = withServiceValidation(service.execute, definition)
    expect(await execute(statusRequest)).toMatchObject({
      ok: true,
      status: {
        redacted: true,
        state: 'uninstalled',
        ready: false
      }
    })
    expect(getPath).toHaveBeenCalledWith('userData')
    expect(await fs.readdir(userData)).toEqual(['figplugin-center'])
    expect(await fs.readdir(path.join(userData, 'figplugin-center'))).toEqual([])
  })

  it('supports an injected isolated store without reading settings or app paths', async () => {
    const service = new FigPluginCenterSvcImpl(
      new FigPluginCenterStore(path.join(userData, 'injected'))
    )
    expect(await service.execute(statusRequest)).toMatchObject({ ok: true })
    expect(getPath).not.toHaveBeenCalled()
    expect(await fs.readdir(userData)).toEqual(['injected'])
  })

  it('accepts only the registered live desktop main frame for renderer IPC', async () => {
    const destroyed = vi.fn(() => false)
    registerMagicAgentTrustedRouteBinding(42, undefined, {
      trustedUrl: 'file:///app/index.html',
      trustedWebContents: { id: 42, isDestroyed: destroyed }
    })
    const service = new FigPluginCenterSvcImpl()
    const execute = withServiceValidation(service.execute, apiDef.svcFigPluginCenter.execute)
    const trusted: ServiceInvocationContext = {
      methodName: 'svcFigPluginCenter.execute',
      senderId: 42,
      senderUrl: 'file:///app/index.html#/workshop/plugins',
      frameUrl: 'file:///app/index.html#/workshop/plugins',
      isMainFrame: true
    }
    expect(await execute(statusRequest, trusted)).toMatchObject({ ok: true })
    const storeFiles = await fs.readdir(path.join(userData, 'figplugin-center'))
    const removal = FigPluginCenterOperationSchema.parse({
      ...statusRequest,
      kind: 'uninstall',
      consent: {
        granted: true,
        permissions: ['uninstall'],
        source: 'system',
        grantedAt: '2026-01-01T00:00:00.000Z'
      }
    })
    for (const override of [
      { senderId: 99 },
      { senderId: undefined },
      { isMainFrame: false },
      { isMainFrame: undefined },
      { frameUrl: 'https://untrusted.invalid/#/workshop/plugins' },
      { frameUrl: 'file:///other/index.html#/workshop/plugins' },
      { senderUrl: 'https://untrusted.invalid/' },
      { methodName: 'svcOther.execute' }
    ]) {
      getPath.mockClear()
      await expect(execute(removal, { ...trusted, ...override })).rejects.toMatchObject({
        code: 'PERMISSION_DENIED',
        cause: undefined
      })
      expect(getPath).not.toHaveBeenCalled()
      expect(await fs.readdir(path.join(userData, 'figplugin-center'))).toEqual(storeFiles)
    }
    destroyed.mockReturnValue(true)
    await expect(execute(removal, trusted)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    destroyed.mockReturnValue(false)
    unregisterMagicAgentTrustedRouteBinding(42)
    await expect(execute(removal, trusted)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('redacts validation causes and filesystem failures before main-process error handling', async () => {
    const service = new FigPluginCenterSvcImpl()
    const execute = withServiceValidation(service.execute, apiDef.svcFigPluginCenter.execute)
    const invalid = { ...statusRequest, 'secret-token': 'C:/fixture-data/secret' }
    const error = await execute(invalid).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ServiceValidationError)
    expect(JSON.stringify(error)).not.toContain('secret')
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', cause: undefined })
    expect(getPath).not.toHaveBeenCalled()
    getPath.mockImplementation(() => {
      throw new Error(`secret ${userData}`)
    })
    const response = await execute(statusRequest)
    expect(response).toMatchObject({ ok: false, failure: { reason: 'internal-error' } })
    expect(JSON.stringify(response)).not.toContain(userData)
    expect(JSON.stringify(response)).not.toContain('secret')
  })
})
