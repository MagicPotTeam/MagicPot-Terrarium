import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import QAppInputPanel from './QAppInputPanel'
import { getQAppSessionKey } from '../utils/qAppSessionIdentity'

const buildQAppMock = vi.fn()
const notifyErrorMock = vi.fn()

vi.mock('./buildQApp', () => ({
  default: (...args: unknown[]) => buildQAppMock(...args)
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: notifyErrorMock
  })
}))

vi.mock('@renderer/store', () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      comfyStatus: {
        isConnected: true,
        objectInfos: {}
      }
    })
}))

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: {
      client_id: 'legacy-client-id'
    },
    buildEnv: {}
  })
}))

const useQAppContextMock = vi.fn()
vi.mock('../components/QAppContext', () => ({
  useQAppContext: () => useQAppContextMock()
}))

describe('QAppInputPanel', () => {
  beforeEach(() => {
    buildQAppMock.mockReset()
    notifyErrorMock.mockReset()
    useQAppContextMock.mockReset()
  })

  it('prefers the shared quickapp session key as panel clientId when a qapp key is active', async () => {
    buildQAppMock.mockReturnValue(({ clientId }: { clientId: string }) => <div>{clientId}</div>)
    useQAppContextMock.mockReturnValue({
      workflow: { nodes: {} },
      qAppCfg: { key: 'demo-qapp' },
      isLoading: false,
      currentQAppKey: '~builtin/hunyuan3d/concept'
    })

    render(<QAppInputPanel fallback={<div>loading</div>} />)

    expect(
      await screen.findByText(
        getQAppSessionKey({
          qAppKey: '~builtin/hunyuan3d/concept'
        })
      )
    ).toBeTruthy()
    expect(screen.queryByText('legacy-client-id')).toBeNull()
  })

  it('falls back to config.client_id when there is no active qapp key', async () => {
    buildQAppMock.mockReturnValue(({ clientId }: { clientId: string }) => <div>{clientId}</div>)
    useQAppContextMock.mockReturnValue({
      workflow: { nodes: {} },
      qAppCfg: { key: 'demo-qapp' },
      isLoading: false,
      currentQAppKey: undefined
    })

    render(<QAppInputPanel fallback={<div>loading</div>} />)

    expect(await screen.findByText('legacy-client-id')).toBeTruthy()
  })
})
