import { describe, expect, it, vi } from 'vitest'

const { mkdirSyncMock } = vi.hoisted(() => ({ mkdirSyncMock: vi.fn() }))

vi.mock('fs', () => ({
  default: { mkdirSync: mkdirSyncMock }
}))

import { createPortablePythonEnv } from './portablePaths'

describe('createPortablePythonEnv', () => {
  it('disables z-tipo runtime package installation', () => {
    const env = createPortablePythonEnv('C:/MagicPot/data', {})

    expect(env.TIPO_NO_AUTO_INSTALL).toBe('1')
  })
})
