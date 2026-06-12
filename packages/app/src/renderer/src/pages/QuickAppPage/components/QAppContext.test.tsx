import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Fragment, createElement } from 'react'

const notifyErrorMock = vi.fn()

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: notifyErrorMock
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({})
}))

import {
  clearCachedQAppState,
  getGlobalQAppCache,
  QAppContextProvider,
  renameCachedQAppState,
  restoreGlobalQAppCache,
  useQAppContext,
  useQAppInputState
} from './QAppContext'

const InputStateProbe = ({ formKey, defaultValue }: { formKey: string; defaultValue: string }) => {
  const [value, setValue] = useQAppInputState(formKey, defaultValue)

  return createElement(
    Fragment,
    null,
    createElement('div', { 'data-testid': 'probe-value' }, value),
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => setValue('manual override')
      },
      'set manual override'
    )
  )
}

type SizeValue = {
  width: number
  height: number
}

const ObjectInputStateProbe = ({ width, height }: SizeValue) => {
  const [value] = useQAppInputState<SizeValue>('size', { width, height })

  return createElement(
    'div',
    { 'data-testid': 'object-probe-value' },
    `${value.width}x${value.height}`
  )
}

const SubmitIdentityProbe = ({
  clientId,
  sessionKey
}: {
  clientId?: string
  sessionKey?: string
}) => {
  const { submitClientId, submitSessionKey, setSubmitClientId, setSubmitSessionKey } =
    useQAppContext()

  return createElement(
    Fragment,
    null,
    createElement('div', { 'data-testid': 'submit-client-id' }, submitClientId || ''),
    createElement('div', { 'data-testid': 'submit-session-key' }, submitSessionKey || ''),
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => setSubmitClientId(clientId)
      },
      'set submit client'
    ),
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => setSubmitClientId(undefined)
      },
      'clear submit client'
    ),
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => setSubmitSessionKey(sessionKey)
      },
      'set submit session'
    ),
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => setSubmitSessionKey(undefined)
      },
      'clear submit session'
    )
  )
}

describe('QAppContext cache helpers', () => {
  beforeEach(() => {
    notifyErrorMock.mockClear()
    clearCachedQAppState()
  })

  it('clears stale cache for same-name quick app saves', () => {
    restoreGlobalQAppCache({
      demo: {
        cfg: { name: 'old demo' },
        workflow: { '1': { class_type: 'OldNode' } },
        formState: { prompt: 'stale prompt', strength: 0.5 }
      }
    })

    clearCachedQAppState('demo')

    expect(getGlobalQAppCache()).toEqual({})
  })

  it('dispatches cache-invalidated event when clearing a specific key', () => {
    const handler = vi.fn()
    window.addEventListener('qapp:cache-invalidated', handler)

    restoreGlobalQAppCache({
      myApp: {
        cfg: { name: 'my app' },
        workflow: { '1': { class_type: 'Node' } },
        formState: { prompt: 'old' }
      }
    })

    clearCachedQAppState('myApp')

    expect(handler).toHaveBeenCalledTimes(1)
    const event = handler.mock.calls[0][0] as CustomEvent
    expect(event.detail).toEqual({ key: 'myApp' })

    window.removeEventListener('qapp:cache-invalidated', handler)
  })

  it('moves cache to the renamed key and overwrites stale target cache', () => {
    restoreGlobalQAppCache({
      source: {
        cfg: { name: 'fresh source' },
        workflow: { '1': { class_type: 'FreshNode' } },
        formState: { prompt: 'fresh prompt' }
      },
      target: {
        cfg: { name: 'stale target' },
        workflow: { '9': { class_type: 'StaleNode' } },
        formState: { prompt: 'stale prompt' }
      }
    })

    renameCachedQAppState('source', 'target')

    expect(getGlobalQAppCache()).toEqual({
      target: {
        cfg: { name: 'fresh source' },
        workflow: { '1': { class_type: 'FreshNode' } },
        formState: { prompt: 'fresh prompt' }
      }
    })
  })
})

describe('useQAppInputState', () => {
  beforeEach(() => {
    notifyErrorMock.mockClear()
    clearCachedQAppState()
  })

  it('resets to the latest default value when the same quick app key is reused with fresh params', () => {
    const { rerender } = render(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <InputStateProbe formKey="prompt" defaultValue="old prompt" />
      </QAppContextProvider>
    )

    expect(screen.getByTestId('probe-value').textContent).toBe('old prompt')

    rerender(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <InputStateProbe formKey="prompt" defaultValue="new prompt" />
      </QAppContextProvider>
    )

    expect(screen.getByTestId('probe-value').textContent).toBe('new prompt')
  })

  it('keeps user-entered values when only the default value changes', () => {
    const { rerender } = render(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <InputStateProbe formKey="prompt" defaultValue="old prompt" />
      </QAppContextProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'set manual override' }))
    expect(screen.getByTestId('probe-value').textContent).toBe('manual override')

    rerender(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <InputStateProbe formKey="prompt" defaultValue="new prompt" />
      </QAppContextProvider>
    )

    expect(screen.getByTestId('probe-value').textContent).toBe('manual override')
  })

  it('restores persisted quick app input values after the in-memory cache is empty', () => {
    localStorage.setItem(
      'qapp.formState.v1.demo',
      JSON.stringify({ prompt: 'persisted prompt', size: { width: 768, height: 1024 } })
    )

    const { rerender } = render(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <InputStateProbe formKey="prompt" defaultValue="default prompt" />
      </QAppContextProvider>
    )

    expect(screen.getByTestId('probe-value').textContent).toBe('persisted prompt')

    rerender(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <ObjectInputStateProbe width={512} height={512} />
      </QAppContextProvider>
    )

    expect(screen.getByTestId('object-probe-value').textContent).toBe('768x1024')
  })

  it('writes user-entered quick app input values to persistent storage', () => {
    render(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <InputStateProbe formKey="prompt" defaultValue="old prompt" />
      </QAppContextProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'set manual override' }))

    expect(JSON.parse(localStorage.getItem('qapp.formState.v1.demo') || '{}')).toMatchObject({
      prompt: 'manual override'
    })
  })

  it('does not persist equivalent object defaults on rerender', () => {
    const { rerender } = render(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <ObjectInputStateProbe width={512} height={512} />
      </QAppContextProvider>
    )

    expect(screen.getByTestId('object-probe-value').textContent).toBe('512x512')

    rerender(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <ObjectInputStateProbe width={512} height={512} />
      </QAppContextProvider>
    )
    rerender(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <ObjectInputStateProbe width={512} height={512} />
      </QAppContextProvider>
    )

    expect(getGlobalQAppCache()).toEqual({
      demo: {
        cfg: null,
        workflow: null,
        formState: {}
      }
    })
  })
})

describe('QAppContext submit identity', () => {
  beforeEach(() => {
    notifyErrorMock.mockClear()
    clearCachedQAppState()
  })

  it('stores and clears the submit client and session identity through context state', () => {
    render(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <SubmitIdentityProbe clientId=" renderer-panel " sessionKey=" quickapp:topic:demo " />
      </QAppContextProvider>
    )

    expect(screen.getByTestId('submit-client-id').textContent).toBe('')
    expect(screen.getByTestId('submit-session-key').textContent).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'set submit client' }))
    expect(screen.getByTestId('submit-client-id').textContent).toBe('renderer-panel')

    fireEvent.click(screen.getByRole('button', { name: 'set submit session' }))
    expect(screen.getByTestId('submit-session-key').textContent).toBe('quickapp:topic:demo')

    fireEvent.click(screen.getByRole('button', { name: 'clear submit client' }))
    expect(screen.getByTestId('submit-client-id').textContent).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'clear submit session' }))
    expect(screen.getByTestId('submit-session-key').textContent).toBe('')
  })
})
