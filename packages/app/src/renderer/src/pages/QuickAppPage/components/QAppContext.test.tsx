import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Fragment, createElement } from 'react'

const notifyErrorMock = vi.fn()
const comfyGetViewMock = vi.fn()
const comfyUploadImageMock = vi.fn()
const qAppGetQAppCfgMock = vi.fn()

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyError: (message: string, duration?: number | null) => notifyErrorMock(message, duration)
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcComfy: {
      getView: comfyGetViewMock,
      uploadImage: comfyUploadImageMock
    },
    svcQApp: {
      getQAppCfg: qAppGetQAppCfgMock
    }
  })
}))

import {
  clearCachedQAppState,
  dispatchQAppFillParams,
  getGlobalQAppCache,
  QAppContextProvider,
  renameCachedQAppState,
  restoreGlobalQAppCache,
  useQAppContext,
  useQAppInputState
} from './QAppContext'
import { encodeDeferredComfyImageInputValue } from '@shared/comfy/deferredImages'

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

const FormStateValueProbe = ({ formKey }: { formKey: string }) => {
  const { formState } = useQAppContext()
  const value = formState.get(formKey)

  return createElement(
    'div',
    { 'data-testid': 'form-state-value' },
    typeof value === 'string' ? value : JSON.stringify(value ?? null)
  )
}

const ContextSnapshotProbe = ({ formKey }: { formKey: string }) => {
  const { currentQAppKey, formState, qAppCfg, workflow, isLoading } = useQAppContext()
  const value = formState.get(formKey)

  return createElement(
    'div',
    { 'data-testid': 'context-snapshot' },
    JSON.stringify({
      currentQAppKey,
      formValue: value ?? null,
      hasCfg: Boolean(qAppCfg),
      hasWorkflow: Boolean(workflow),
      isLoading
    })
  )
}

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const FormStateMutationProbe = ({ formKey, value }: { formKey: string; value: string }) => {
  const { setFormStateValue } = useQAppContext()

  return createElement(
    'button',
    {
      type: 'button',
      onClick: () => setFormStateValue(formKey, value)
    },
    `set ${formKey}`
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
    comfyGetViewMock.mockReset()
    comfyUploadImageMock.mockReset()
    qAppGetQAppCfgMock.mockReset()
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
    comfyGetViewMock.mockReset()
    comfyUploadImageMock.mockReset()
    qAppGetQAppCfgMock.mockReset()
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

  it('fills deferred Comfy image params without fetching or reuploading the image', async () => {
    const deferredValue = encodeDeferredComfyImageInputValue({
      fileName: 'reference.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,cmVmZXJlbmNl',
      sizeBytes: 9
    })

    restoreGlobalQAppCache({
      demo: {
        cfg: {
          icon: 'image',
          inputs: [
            {
              label: 'Reference',
              component: 'InputComfyImage',
              slot: '1.inputs.image'
            }
          ]
        },
        workflow: { '1': { inputs: { image: '' } } },
        formState: {}
      }
    })

    render(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <FormStateValueProbe formKey="1.inputs.image" />
      </QAppContextProvider>
    )

    fireEvent(
      window,
      new CustomEvent('qapp:fillParams', {
        detail: { workflow: { '1': { inputs: { image: deferredValue } } } }
      })
    )

    await waitFor(() => {
      expect(screen.getByTestId('form-state-value').textContent).toBe(deferredValue)
    })
    expect(comfyGetViewMock).not.toHaveBeenCalled()
    expect(comfyUploadImageMock).not.toHaveBeenCalled()
  })

  it('does not downgrade a blank scoped fill-param dispatch to a global fill', async () => {
    restoreGlobalQAppCache({
      demo: {
        cfg: {
          inputs: [
            {
              label: 'Prompt',
              component: 'InputPrompt',
              slot: '1.inputs.text'
            }
          ]
        },
        workflow: { '1': { inputs: { text: '' } } },
        formState: {}
      }
    })

    render(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <FormStateValueProbe formKey="1.inputs.text" />
      </QAppContextProvider>
    )

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    dispatchQAppFillParams({
      qAppKey: '   ',
      workflow: { '1': { inputs: { text: 'should not fill' } } }
    })

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(dispatchSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('form-state-value').textContent).toBe('null')
    dispatchSpy.mockRestore()
  })

  it('keeps a keyed fill pending until the provider mounts and fetches its config', async () => {
    const serverFetch = createDeferred<{
      cfg: { inputs: Array<{ label: string; component: 'InputPrompt'; slot: string }> }
      workflow: Record<string, never>
    }>()
    qAppGetQAppCfgMock.mockReturnValueOnce(serverFetch.promise)
    const workflow = { '1': { inputs: { text: 'filled after server fetch' } } }

    dispatchQAppFillParams({ qAppKey: 'server-app', workflow })

    render(
      <QAppContextProvider qAppKey="server-app">
        <FormStateValueProbe formKey="1.inputs.text" />
      </QAppContextProvider>
    )

    expect(qAppGetQAppCfgMock).toHaveBeenCalledWith({ key: 'server-app' })
    expect(screen.getByTestId('form-state-value').textContent).toBe('null')

    await act(async () => {
      serverFetch.resolve({
        cfg: {
          inputs: [
            {
              label: 'Prompt',
              component: 'InputPrompt',
              slot: '1.inputs.text'
            }
          ]
        },
        workflow: {}
      })
      await serverFetch.promise
    })

    await waitFor(() => {
      expect(screen.getByTestId('form-state-value').textContent).toBe('filled after server fetch')
    })
  })

  it('scopes keyed fill-param events to the matching quick app and applies them after mount', async () => {
    restoreGlobalQAppCache({
      old: {
        cfg: {
          inputs: [
            {
              label: 'Prompt',
              component: 'InputPrompt',
              slot: '1.inputs.text'
            }
          ]
        },
        workflow: { '1': { inputs: { text: '' } } },
        formState: {}
      },
      next: {
        cfg: {
          inputs: [
            {
              label: 'Prompt',
              component: 'InputPrompt',
              slot: '1.inputs.text'
            }
          ]
        },
        workflow: { '1': { inputs: { text: '' } } },
        formState: {}
      }
    })

    const workflow = { '1': { inputs: { text: 'restored for next app' } } }
    const { rerender } = render(
      <QAppContextProvider qAppKey="old" skipServerFetch={true}>
        <FormStateValueProbe formKey="1.inputs.text" />
      </QAppContextProvider>
    )

    dispatchQAppFillParams({ qAppKey: 'next', workflow })

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(screen.getByTestId('form-state-value').textContent).toBe('null')

    rerender(
      <QAppContextProvider qAppKey="next" skipServerFetch={true}>
        <FormStateValueProbe formKey="1.inputs.text" />
      </QAppContextProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('form-state-value').textContent).toBe('restored for next app')
    })
  })

  it('clears stale form state when an unkeyed provider changes quick app keys', async () => {
    restoreGlobalQAppCache({
      old: {
        cfg: { inputs: [] },
        workflow: {},
        formState: { prompt: 'old prompt' }
      }
    })

    const { rerender } = render(
      <QAppContextProvider qAppKey="old" skipServerFetch={true}>
        <FormStateValueProbe formKey="prompt" />
        <FormStateMutationProbe formKey="prompt" value="fresh next prompt" />
      </QAppContextProvider>
    )

    expect(screen.getByTestId('form-state-value').textContent).toBe('old prompt')

    rerender(
      <QAppContextProvider qAppKey="next" skipServerFetch={true}>
        <FormStateValueProbe formKey="prompt" />
        <FormStateMutationProbe formKey="prompt" value="fresh next prompt" />
      </QAppContextProvider>
    )

    expect(screen.getByTestId('form-state-value').textContent).toBe('null')
    await waitFor(() => {
      expect(screen.getByTestId('form-state-value').textContent).toBe('null')
    })
    expect(localStorage.getItem('qapp.formState.v1.next')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'set prompt' }))

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('qapp.formState.v1.next') || '{}')).toMatchObject({
        prompt: 'fresh next prompt'
      })
      expect(getGlobalQAppCache()).toMatchObject({
        next: {
          formState: { prompt: 'fresh next prompt' }
        }
      })
    })
  })

  it('does not expose old cfg/workflow/form state during an unkeyed quick app change render', () => {
    restoreGlobalQAppCache({
      old: {
        cfg: { name: 'old cfg', inputs: [] },
        workflow: { '1': { class_type: 'OldNode', inputs: {} } },
        formState: { prompt: 'old prompt' }
      }
    })

    const { rerender } = render(
      <QAppContextProvider qAppKey="old" skipServerFetch={true}>
        <ContextSnapshotProbe formKey="prompt" />
      </QAppContextProvider>
    )

    expect(JSON.parse(screen.getByTestId('context-snapshot').textContent || '{}')).toMatchObject({
      currentQAppKey: 'old',
      formValue: 'old prompt',
      hasCfg: true,
      hasWorkflow: true,
      isLoading: false
    })

    rerender(
      <QAppContextProvider qAppKey="next" skipServerFetch={true}>
        <ContextSnapshotProbe formKey="prompt" />
      </QAppContextProvider>
    )

    expect(JSON.parse(screen.getByTestId('context-snapshot').textContent || '{}')).toMatchObject({
      currentQAppKey: 'next',
      formValue: null,
      hasCfg: false,
      hasWorkflow: false
    })
  })

  it('unblocks cache writeback when skipServerFetch handles a cache invalidation', async () => {
    restoreGlobalQAppCache({
      demo: {
        cfg: { inputs: [] },
        workflow: {},
        formState: { prompt: 'stale prompt' }
      }
    })

    render(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <FormStateValueProbe formKey="prompt" />
        <FormStateMutationProbe formKey="prompt" value="fresh prompt" />
      </QAppContextProvider>
    )

    expect(screen.getByTestId('form-state-value').textContent).toBe('stale prompt')

    act(() => {
      clearCachedQAppState('demo')
    })
    await waitFor(() => {
      expect(screen.getByTestId('form-state-value').textContent).toBe('null')
    })

    fireEvent.click(screen.getByRole('button', { name: 'set prompt' }))

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('qapp.formState.v1.demo') || '{}')).toMatchObject({
        prompt: 'fresh prompt'
      })
      expect(getGlobalQAppCache()).toMatchObject({
        demo: {
          formState: { prompt: 'fresh prompt' }
        }
      })
    })
  })

  it('keeps restored deferred image form state stable across rerenders', async () => {
    const deferredValue = encodeDeferredComfyImageInputValue({
      fileName: 'persisted-reference.png',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,cGVyc2lzdGVk',
      sizeBytes: 9
    })
    localStorage.setItem(
      'qapp.formState.v1.demo',
      JSON.stringify({ '1.inputs.image': deferredValue })
    )
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    const { rerender } = render(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <FormStateValueProbe formKey="1.inputs.image" />
      </QAppContextProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('form-state-value').textContent).toBe(deferredValue)
      expect(setItemSpy).toHaveBeenCalled()
    })
    setItemSpy.mockClear()

    rerender(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <FormStateValueProbe formKey="1.inputs.image" />
      </QAppContextProvider>
    )
    rerender(
      <QAppContextProvider qAppKey="demo" skipServerFetch={true}>
        <FormStateValueProbe formKey="1.inputs.image" />
      </QAppContextProvider>
    )

    expect(screen.getByTestId('form-state-value').textContent).toBe(deferredValue)
    expect(setItemSpy).not.toHaveBeenCalled()
    setItemSpy.mockRestore()
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
    comfyGetViewMock.mockReset()
    comfyUploadImageMock.mockReset()
    qAppGetQAppCfgMock.mockReset()
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
