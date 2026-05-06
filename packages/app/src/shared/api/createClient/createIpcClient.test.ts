import { describe, expect, it, vi } from 'vitest'
import { createIpcClient } from './createIpcClient'

const { invokeMock, postMessageMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  postMessageMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: invokeMock,
    postMessage: postMessageMock
  }
}))

type TestApi = {
  svcDemo: {
    ping(req: { value: string }): Promise<{ ok: boolean }>
  }
}

describe('createIpcClient', () => {
  it('strips the Electron remote method wrapper from unary errors', async () => {
    invokeMock.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'svcDemo.ping': [Hunyuan3D] 当前配置的腾讯云 SecretId 无效或已失效。"
      )
    )

    const client = createIpcClient<TestApi>({
      svcDemo: {
        ping: { type: 'unary' }
      }
    })

    const error = await client.svcDemo.ping({ value: 'demo' }).then(
      () => {
        throw new Error('Expected unary invoke to fail')
      },
      (caught): Error => caught as Error
    )

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('[Hunyuan3D] 当前配置的腾讯云 SecretId 无效或已失效。')
    expect(error.message).not.toContain('Error invoking remote method')
  })

  it('keeps non-wrapped unary errors unchanged', async () => {
    invokeMock.mockRejectedValueOnce(new Error('Network timeout'))

    const client = createIpcClient<TestApi>({
      svcDemo: {
        ping: { type: 'unary' }
      }
    })

    await expect(client.svcDemo.ping({ value: 'demo' })).rejects.toThrow('Network timeout')
  })
})
