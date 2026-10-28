import { StrictMode, useLayoutEffect } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'
import type { FileInfo, ListComfyFilesReq, ListComfyFilesResp } from '@shared/api/svcHyper'
import type { ServerStreaming } from '@shared/api/apiUtils/streaming'
import { MESSAGE_COMFYUI_DIR_NOT_SET } from '@shared/config/messageConst'
import FileBrowserPannel, { type FileBrowserPannelProps } from './FileBrowserPannel'
import ModelPage from './ModelPage'

const mocks = vi.hoisted(() => ({
  listComfyFiles: vi.fn(),
  showItemInFolder: vi.fn(),
  openPath: vi.fn(),
  clipboardWriteText: vi.fn(),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  useRealTranslations: false
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcHyper: { listComfyFiles: mocks.listComfyFiles },
    svcShell: { showItemInFolder: mocks.showItemInFolder, openPath: mocks.openPath }
  })
}))
vi.mock('@renderer/hooks/useMessage', () => ({ useMessage: () => mocks }))
vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    configUtils: {
      getCheckpointsDir: () => '/old',
      getClipDir: () => '/old',
      getLoraDir: () => '/old',
      getControlnetDir: () => '/old',
      getDiffusionModelsDir: () => '/old',
      getUNetDir: () => '/old',
      getVAEDir: () => '/old',
      getUpscaleModelsDir: () => '/old',
      getWorkflowDir: () => '/old'
    }
  })
}))
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () =>
      mocks.useRealTranslations
        ? actual.useTranslation()
        : {
            t: (key: string, options?: { error?: string }) =>
              key === 'model.open_folder'
                ? 'Open Folder'
                : key === 'model.copy_path'
                  ? 'Copy Path'
                  : key === 'model.copy_path_failed'
                    ? 'Failed to copy path'
                    : key === 'qapp.callout.open_directory_failed'
                      ? `Failed to open folder: ${options?.error}`
                      : key === 'chat.unknown_error'
                        ? 'Unknown error'
                        : key === 'chat.local_files.errors.IO_ERROR'
                          ? 'The local file operation failed.'
                          : key
          }
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Request = ReturnType<typeof deferred<void>> & {
  args: ListComfyFilesReq
  stream: ServerStreaming<ListComfyFilesResp>
}
let requests: Request[] = []
const exts = ['.safetensors', '.ckpt']
const baseProps = { label: 'Models', dirPath: '/old', exts }
const file = (name: string, path?: string): FileInfo => ({ name, path })

function emit(index: number, ...files: FileInfo[]) {
  act(() => files.forEach((entry) => requests[index].stream.onData({ file: entry })))
}

function rootButton() {
  return screen.getByRole('button', { name: /^(Open Folder|打开文件夹)$/ })
}

function revealButton(relativePath: string) {
  return screen.getByRole('button', { name: `Open Folder: ${relativePath}` })
}

function CommitProbe({ onCommit, ...props }: FileBrowserPannelProps & { onCommit: () => void }) {
  useLayoutEffect(() => {
    onCommit()
  })
  return <FileBrowserPannel {...props} />
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useRealTranslations = false
  requests = []
  mocks.listComfyFiles.mockImplementation(
    (args: ListComfyFilesReq, stream: ServerStreaming<ListComfyFilesResp>) => {
      const request = { ...deferred<void>(), args, stream }
      requests.push(request)
      return request.promise
    }
  )
  mocks.showItemInFolder.mockResolvedValue(undefined)
  mocks.openPath.mockResolvedValue('')
  mocks.clipboardWriteText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.clipboardWriteText }
  })
})

describe('FileBrowserPannel localized pending failures', () => {
  for (const [initialLanguage, finalLanguage] of [
    ['en-US', 'zh-CN'],
    ['zh-CN', 'en-US']
  ]) {
    it.each(['listing', 'root', 'reveal'] as const)(
      `${initialLanguage} to ${finalLanguage}: reports pending %s in the current language without relisting`,
      async (action) => {
        mocks.useRealTranslations = true
        const i18n = createInstance()
        await i18n.use(initReactI18next).init({
          lng: initialLanguage,
          fallbackLng: 'en-US',
          resources: { 'en-US': { translation: en }, 'zh-CN': { translation: zh } },
          interpolation: { escapeValue: false }
        })
        const pending = deferred<string>()
        if (action === 'root') mocks.openPath.mockReturnValue(pending.promise)
        if (action === 'reveal') mocks.showItemInFolder.mockReturnValue(pending.promise)
        render(
          <I18nextProvider i18n={i18n}>
            <FileBrowserPannel {...baseProps} />
          </I18nextProvider>
        )
        emit(0, file('model.ckpt', '/old/model.ckpt'))
        if (action !== 'listing') {
          const name = i18n.t('model.open_folder') + (action === 'reveal' ? ': model.ckpt' : '')
          fireEvent.click(screen.getByRole('button', { name }))
        }
        expect(mocks.listComfyFiles).toHaveBeenCalledTimes(1)
        await act(async () => {
          await i18n.changeLanguage(finalLanguage)
        })
        expect(mocks.listComfyFiles).toHaveBeenCalledTimes(1)
        await act(async () => {
          const error = new Error('D:/synthetic-private/native-detail')
          if (action === 'listing') requests[0].reject(error)
          else pending.reject(error)
        })
        const expected =
          action === 'listing'
            ? i18n.t('chat.local_files.errors.IO_ERROR')
            : i18n.t('qapp.callout.open_directory_failed', { error: i18n.t('chat.unknown_error') })
        expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(expected)
        expect(mocks.listComfyFiles).toHaveBeenCalledTimes(1)
        expect(mocks.openPath).toHaveBeenCalledTimes(action === 'root' ? 1 : 0)
        expect(mocks.showItemInFolder).toHaveBeenCalledTimes(action === 'reveal' ? 1 : 0)
        expect(JSON.stringify(mocks.notifyError.mock.calls)).not.toContain('synthetic-private')
      }
    )
  }
})

describe('ModelPage with its real file panel', () => {
  const languageChanges = [
    ['en-US', 'zh-CN'],
    ['zh-CN', 'en-US']
  ] as const
  const tabs = [
    'models',
    'clip',
    'lora',
    'controlnet',
    'diffusion_models',
    'unet',
    'vae',
    'upscale_models',
    'workflow'
  ] as const
  const mountPage = async (language: string) => {
    mocks.useRealTranslations = true
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({
      lng: language,
      fallbackLng: 'en-US',
      resources: { 'en-US': { translation: en }, 'zh-CN': { translation: zh } },
      interpolation: { escapeValue: false }
    })
    render(
      <I18nextProvider i18n={i18n}>
        <ModelPage />
      </I18nextProvider>
    )
    return i18n
  }
  for (const [from, to] of languageChanges) {
    it.each(tabs)(
      `${from} to ${to} keeps the pending %s listing and uses the current safe error`,
      async (tab) => {
        const i18n = await mountPage(from)
        fireEvent.click(screen.getByRole('tab', { name: i18n.t(`model.tabs.${tab}`) }))
        const count = requests.length
        const current = requests[count - 1]
        emit(count - 1, file('model.ckpt', '/old/model.ckpt'))
        const input = screen.getByRole('textbox')
        fireEvent.change(input, { target: { value: 'model' } })
        await act(async () => {
          await i18n.changeLanguage(to)
        })
        expect(mocks.listComfyFiles).toHaveBeenCalledTimes(count)
        expect(current.stream.abortReceiver?.isAborted()).toBe(false)
        expect(input).toHaveValue('model')
        expect(
          screen.getByRole('button', { name: `${i18n.t('model.open_folder')}: model.ckpt` })
        ).toBeEnabled()
        await act(async () => current.reject(new Error('D:/fixture-data/listing-detail')))
        expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(
          i18n.t('chat.local_files.errors.IO_ERROR')
        )
        expect(mocks.listComfyFiles).toHaveBeenCalledTimes(count)
        expect(mocks.openPath).not.toHaveBeenCalled()
        expect(mocks.showItemInFolder).not.toHaveBeenCalled()
      }
    )
    it.each(['root', 'reveal'] as const)(
      `${from} to ${to} keeps pending %s protection and current-language feedback`,
      async (action) => {
        const i18n = await mountPage(from)
        const pending = deferred<string>()
        const dispatch = action === 'root' ? mocks.openPath : mocks.showItemInFolder
        dispatch.mockReturnValue(pending.promise)
        emit(0, file('model.ckpt', '/old/model.ckpt'))
        const name = () => i18n.t('model.open_folder') + (action === 'reveal' ? ': model.ckpt' : '')
        fireEvent.click(screen.getByRole('button', { name: name() }))
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(
          action === 'root' ? '/old' : '/old/model.ckpt'
        )
        await act(async () => {
          await i18n.changeLanguage(to)
        })
        expect(mocks.listComfyFiles).toHaveBeenCalledTimes(1)
        expect(requests[0].stream.abortReceiver?.isAborted()).toBe(false)
        const button = screen.getByRole('button', { name: name() })
        expect(button).toBeDisabled()
        fireEvent.click(button)
        expect(dispatch).toHaveBeenCalledTimes(1)
        await act(async () => pending.reject(new Error('D:/fixture-data/shell-detail')))
        expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(
          i18n.t('qapp.callout.open_directory_failed', { error: i18n.t('chat.unknown_error') })
        )
        expect(button).toBeEnabled()
        expect(mocks.listComfyFiles).toHaveBeenCalledTimes(1)
      }
    )
  }
  it('still invalidates A-B-A categories with identical roots and extension values', async () => {
    const i18n = await mountPage('en-US')
    const first = deferred<string>()
    const latest = deferred<string>()
    mocks.showItemInFolder.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise)
    emit(0, file('model.ckpt', '/old/model.ckpt'))
    fireEvent.click(revealButton('model.ckpt'))
    fireEvent.click(screen.getByRole('tab', { name: i18n.t('model.tabs.controlnet') }))
    expect(requests[0].stream.abortReceiver?.isAborted()).toBe(true)
    expect(screen.queryByRole('button', { name: 'Open Folder: model.ckpt' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: i18n.t('model.tabs.models') }))
    expect(requests[1].stream.abortReceiver?.isAborted()).toBe(true)
    expect(requests).toHaveLength(3)
    emit(2, file('model.ckpt', '/old/model.ckpt'))
    fireEvent.click(revealButton('model.ckpt'))
    await act(async () => {
      first.reject(new Error('stale shell detail'))
      requests[0].reject(new Error('stale listing detail'))
    })
    expect(mocks.notifyError).not.toHaveBeenCalled()
    expect(revealButton('model.ckpt')).toBeDisabled()
    await act(async () => latest.reject(new Error('current shell detail')))
    expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(
      'Failed to open folder: Unknown error'
    )
    expect(revealButton('model.ckpt')).toBeEnabled()
    expect(mocks.showItemInFolder).toHaveBeenCalledTimes(2)
    expect(mocks.openPath).not.toHaveBeenCalled()
  })
})

describe('FileBrowserPannel file actions', () => {
  it('keeps streamed paths, deduplication, sorting and Unicode filtering without shell calls', () => {
    render(<FileBrowserPannel {...baseProps} />)
    expect(requests[0].args).toEqual({ dir: '/old', exts })
    emit(
      0,
      file('z.ckpt', '/old/z.ckpt'),
      file('模型.safetensors', '/old/嵌套 Folder/模型.safetensors'),
      file('a.ckpt', '/old/a.ckpt'),
      file('z.ckpt', '/old/z.ckpt')
    )
    const paths = ['z.ckpt', '嵌套 Folder/模型.safetensors', 'a.ckpt'].sort((a, b) =>
      a.localeCompare(b)
    )
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    rows.forEach((row, index) => expect(within(row).getByText(paths[index])).toBeInTheDocument())
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'folder/模' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.click(screen.getByText('嵌套 Folder/模型.safetensors'))
    expect(mocks.listComfyFiles).toHaveBeenCalledTimes(1)
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  it('reveals only the explicitly selected current file using its exact unmodified path', async () => {
    const { rerender } = render(<FileBrowserPannel {...baseProps} />)
    emit(0, file('模型.safetensors', '/old/模型.safetensors'))
    rerender(<FileBrowserPannel {...baseProps} dirPath={'D:\\Models'} />)
    const exactPath = 'D:\\Models\\嵌套 Folder\\模型.safetensors'
    emit(
      1,
      file('模型.safetensors', exactPath),
      file('模型.safetensors', 'D:\\Models\\other\\模型.safetensors')
    )
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(revealButton('嵌套 Folder\\模型.safetensors')))
    expect(mocks.showItemInFolder).toHaveBeenCalledExactlyOnceWith(exactPath)
    expect(mocks.openPath).not.toHaveBeenCalled()
    expect(mocks.notifySuccess).not.toHaveBeenCalled()
  })

  it.each(['model.ckpt', 'another.ckpt'])(
    'preserves the focused reveal target when sorted stream insertion adds %s',
    async (newName) => {
      render(<FileBrowserPannel {...baseProps} />)
      emit(0, file('model.ckpt', '/old/b/model.ckpt'))
      const focused = revealButton('b/model.ckpt')
      focused.focus()
      expect(focused).toHaveFocus()
      emit(0, file(newName, `/old/a/${newName}`))
      expect(revealButton('b/model.ckpt')).toBe(focused)
      expect(focused).toHaveFocus()
      expect(document.activeElement).toHaveAccessibleName('Open Folder: b/model.ckpt')
      await act(async () => fireEvent.click(document.activeElement!))
      expect(mocks.showItemInFolder).toHaveBeenCalledExactlyOnceWith('/old/b/model.ckpt')
    }
  )

  it.each([undefined, ''])(
    'disables reveal for a missing path (%s) instead of inferring one',
    (path) => {
      render(<FileBrowserPannel {...baseProps} />)
      emit(0, file('missing.ckpt', path))
      const button = revealButton('missing.ckpt')
      expect(button).toBeDisabled()
      fireEvent.click(button)
      expect(mocks.showItemInFolder).not.toHaveBeenCalled()
      expect(mocks.openPath).not.toHaveBeenCalled()
    }
  )

  it('blocks same-turn duplicate reveals while pending and allows a later explicit retry', async () => {
    const pending = deferred<void>()
    mocks.showItemInFolder.mockReturnValue(pending.promise)
    render(<FileBrowserPannel {...baseProps} />)
    emit(0, file('model.ckpt', '/old/model.ckpt'))
    const button = revealButton('model.ckpt')
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(mocks.showItemInFolder).toHaveBeenCalledExactlyOnceWith('/old/model.ckpt')
    expect(button).toBeDisabled()
    await act(async () => pending.resolve())
    expect(button).toBeEnabled()
    await act(async () => fireEvent.click(button))
    expect(mocks.showItemInFolder).toHaveBeenCalledTimes(2)
  })

  it.each(['rejected promise', 'synchronous throw'])(
    'reports reveal %s without claiming success',
    async (kind) => {
      mocks.showItemInFolder.mockImplementation(() => {
        if (kind === 'synchronous throw') throw new Error('Reveal denied')
        return Promise.reject(new Error('Reveal denied'))
      })
      render(<FileBrowserPannel {...baseProps} />)
      emit(0, file('model.ckpt', '/old/model.ckpt'))
      const button = revealButton('model.ckpt')
      await act(async () => fireEvent.click(button))
      expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(
        'Failed to open folder: Unknown error'
      )
      expect(mocks.notifySuccess).not.toHaveBeenCalled()
      expect(button).toBeEnabled()
    }
  )

  it('copies the exact selected file path and blocks duplicate pending copies', async () => {
    const pending = deferred<void>()
    mocks.clipboardWriteText.mockReturnValue(pending.promise)
    render(<FileBrowserPannel {...baseProps} />)
    emit(0, file('model.ckpt', '/old/nested/model.ckpt'))
    const button = screen.getByRole('button', { name: 'Copy Path: nested/model.ckpt' })
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(mocks.clipboardWriteText).toHaveBeenCalledExactlyOnceWith('/old/nested/model.ckpt')
    expect(button).toBeDisabled()
    await act(async () => pending.resolve())
    expect(button).toBeEnabled()
    await act(async () => fireEvent.click(button))
    expect(mocks.clipboardWriteText).toHaveBeenCalledTimes(2)
  })

  it('reports clipboard failures without exposing native details', async () => {
    mocks.clipboardWriteText.mockRejectedValue(new Error('PRIVATE clipboard detail'))
    render(<FileBrowserPannel {...baseProps} />)
    emit(0, file('model.ckpt', '/old/model.ckpt'))
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Copy Path: model.ckpt' }))
    )
    expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith('Failed to copy path')
    expect(JSON.stringify(mocks.notifyError.mock.calls)).not.toContain('PRIVATE')
  })

  it('opens only the current root on click and blocks pending duplicates', async () => {
    const pending = deferred<string>()
    mocks.openPath.mockReturnValue(pending.promise)
    render(<FileBrowserPannel {...baseProps} />)
    expect(mocks.openPath).not.toHaveBeenCalled()
    const button = rootButton()
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(mocks.openPath).toHaveBeenCalledExactlyOnceWith('/old')
    expect(button).toBeDisabled()
    await act(async () => pending.resolve(''))
    expect(button).toBeEnabled()
    expect(mocks.notifyError).not.toHaveBeenCalled()
  })

  it.each(['rejection', 'error string'])('reports root Open Folder %s safely', async (kind) => {
    if (kind === 'rejection') mocks.openPath.mockRejectedValue(new Error('Open denied'))
    else mocks.openPath.mockResolvedValue('Open denied')
    render(<FileBrowserPannel {...baseProps} />)
    await act(async () => fireEvent.click(rootButton()))
    expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(
      'Failed to open folder: Unknown error'
    )
    expect(mocks.notifySuccess).not.toHaveBeenCalled()
    expect(rootButton()).toBeEnabled()
  })

  it.each([undefined, null, false, 0])(
    'rejects malformed falsy root responses (%s) rather than accepting success',
    async (response) => {
      mocks.openPath.mockResolvedValue(response)
      render(<FileBrowserPannel {...baseProps} />)
      await act(async () => fireEvent.click(rootButton()))
      expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(
        'Failed to open folder: Unknown error'
      )
      expect(rootButton()).toBeEnabled()
      expect(mocks.notifySuccess).not.toHaveBeenCalled()
    }
  )

  it.each(['root', 'reveal', 'listing'] as const)(
    'does not reflect or coerce rejected native details for %s',
    async (action) => {
      const secret = 'D:\\private-fixture\\key=synthetic-only'
      const message = vi.fn(() => secret)
      const coerce = vi.fn(() => secret)
      const error = Object.create(null)
      Object.defineProperty(error, 'message', { get: message })
      Object.defineProperty(error, Symbol.toPrimitive, { value: coerce })
      if (action === 'root') mocks.openPath.mockRejectedValue(error)
      if (action === 'reveal') mocks.showItemInFolder.mockRejectedValue(error)
      render(<FileBrowserPannel {...baseProps} />)
      emit(0, file('model.ckpt', '/old/model.ckpt'))
      await act(async () => {
        if (action === 'listing') requests[0].reject(error)
        else fireEvent.click(action === 'root' ? rootButton() : revealButton('model.ckpt'))
      })
      expect(message).not.toHaveBeenCalled()
      expect(coerce).not.toHaveBeenCalled()
      expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(
        action === 'listing'
          ? 'The local file operation failed.'
          : 'Failed to open folder: Unknown error'
      )
      expect(JSON.stringify(mocks.notifyError.mock.calls)).not.toContain(secret)
      expect(mocks.notifySuccess).not.toHaveBeenCalled()
    }
  )

  it.each(['root', 'reveal', 'listing'] as const)(
    'redacts native error strings from the current %s failure',
    async (action) => {
      const secret = 'D:/fixture-data/secret-token-synthetic'
      if (action === 'root') mocks.openPath.mockResolvedValue(secret)
      if (action === 'reveal') mocks.showItemInFolder.mockRejectedValue(secret)
      render(<FileBrowserPannel {...baseProps} />)
      emit(0, file('model.ckpt', '/old/model.ckpt'))
      await act(async () => {
        if (action === 'listing') requests[0].reject(secret)
        else fireEvent.click(action === 'root' ? rootButton() : revealButton('model.ckpt'))
      })
      expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(
        action === 'listing'
          ? 'The local file operation failed.'
          : 'Failed to open folder: Unknown error'
      )
      expect(JSON.stringify(mocks.notifyError.mock.calls)).not.toContain(secret)
    }
  )

  it('does not list or open an unset directory and retains the existing error', () => {
    render(<FileBrowserPannel {...baseProps} dirPath="" />)
    fireEvent.click(rootButton())
    expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith(MESSAGE_COMFYUI_DIR_NOT_SET)
    expect(mocks.listComfyFiles).not.toHaveBeenCalled()
    expect(mocks.openPath).not.toHaveBeenCalled()
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
  })

  it.each(['switch', 'unmount'])('ignores a pending shell failure after %s', async (kind) => {
    const pending = deferred<void>()
    mocks.showItemInFolder.mockReturnValue(pending.promise)
    const view = render(<FileBrowserPannel {...baseProps} />)
    emit(0, file('model.ckpt', '/old/model.ckpt'))
    fireEvent.click(revealButton('model.ckpt'))
    if (kind === 'switch') view.rerender(<FileBrowserPannel {...baseProps} dirPath="/new" />)
    else view.unmount()
    await act(async () => pending.reject(new Error('Stale reveal failure')))
    expect(mocks.notifyError).not.toHaveBeenCalled()
    expect(mocks.notifySuccess).not.toHaveBeenCalled()
  })

  it('keeps the current root action pending when an old root action rejects and finalizes', async () => {
    const oldOpen = deferred<string>()
    const currentOpen = deferred<string>()
    mocks.openPath.mockReturnValueOnce(oldOpen.promise).mockReturnValueOnce(currentOpen.promise)
    const view = render(<FileBrowserPannel {...baseProps} />)
    fireEvent.click(rootButton())
    view.rerender(<FileBrowserPannel {...baseProps} dirPath="/new" />)
    expect(rootButton()).toBeEnabled()
    fireEvent.click(rootButton())
    await act(async () => oldOpen.reject(new Error('Old open failed')))
    expect(rootButton()).toBeDisabled()
    expect(mocks.notifyError).not.toHaveBeenCalled()
    expect(mocks.openPath.mock.calls).toEqual([['/old'], ['/new']])
    await act(async () => currentOpen.resolve(''))
    expect(rootButton()).toBeEnabled()
  })
})

describe('FileBrowserPannel stream lifetime', () => {
  it.each(['/new', ''])(
    'hides the old scope in the commit to root "%s", before passive effects',
    (dirPath) => {
      const observed: boolean[] = []
      const onCommit = () => {
        observed.push(Boolean(screen.queryByText('old.ckpt')))
      }
      const view = render(<CommitProbe {...baseProps} onCommit={onCommit} />)
      emit(0, file('old.ckpt', '/old/old.ckpt'))
      expect(screen.getByText('old.ckpt')).toBeInTheDocument()
      view.rerender(<CommitProbe {...baseProps} dirPath={dirPath} onCommit={onCommit} />)
      expect(observed.at(-1)).toBe(false)
    }
  )

  it.each(['resolve', 'reject'])(
    'ignores old root data and %s/finally without ending the new loading state',
    async (settlement) => {
      const view = render(<FileBrowserPannel {...baseProps} />)
      emit(0, file('old.ckpt', '/old/old.ckpt'))
      view.rerender(<FileBrowserPannel {...baseProps} dirPath="/new" />)
      emit(0, file('late.ckpt', '/old/late.ckpt'))
      expect(screen.queryByText(/late\.ckpt/)).not.toBeInTheDocument()
      await act(async () => {
        if (settlement === 'resolve') requests[0].resolve()
        else requests[0].reject(new Error('Old list failure'))
      })
      expect(mocks.notifyError).not.toHaveBeenCalled()
      expect(screen.queryByText('暂无Models')).not.toBeInTheDocument()
      emit(1, file('current.ckpt', '/new/current.ckpt'))
      await act(async () => requests[1].resolve())
      expect(screen.getByText('current.ckpt')).toBeInTheDocument()
      expect(screen.queryByText(/old\.ckpt|late\.ckpt/)).not.toBeInTheDocument()
    }
  )

  it('invalidates extension changes even when the directory does not change', async () => {
    const view = render(<FileBrowserPannel {...baseProps} />)
    emit(0, file('old.ckpt', '/old/old.ckpt'))
    view.rerender(<FileBrowserPannel {...baseProps} exts={['.bin']} />)
    expect(requests[1].args).toEqual({ dir: '/old', exts: ['.bin'] })
    emit(0, file('late.ckpt', '/old/late.ckpt'))
    await act(async () => requests[0].reject(new Error('Old extension failure')))
    expect(screen.queryByText(/old\.ckpt|late\.ckpt|暂无Models/)).not.toBeInTheDocument()
    expect(mocks.notifyError).not.toHaveBeenCalled()
    emit(1, file('current.bin', '/old/current.bin'))
    expect(screen.getByText('current.bin')).toBeInTheDocument()
    expect(requests[0].stream.abortReceiver?.isAborted()).toBe(true)
  })

  it('clears an empty root immediately and rejects all late data/errors without another request', async () => {
    const view = render(<FileBrowserPannel {...baseProps} />)
    emit(0, file('old.ckpt', '/old/old.ckpt'))
    view.rerender(<FileBrowserPannel {...baseProps} dirPath="" />)
    expect(screen.queryByText(/old\.ckpt/)).not.toBeInTheDocument()
    expect(screen.getByText('暂无Models')).toBeInTheDocument()
    emit(0, file('late.ckpt', '/old/late.ckpt'))
    await act(async () => requests[0].reject(new Error('Late empty-root failure')))
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(mocks.listComfyFiles).toHaveBeenCalledTimes(1)
    expect(mocks.notifyError).not.toHaveBeenCalled()
    expect(requests[0].stream.abortReceiver?.isAborted()).toBe(true)
  })

  it('aborts on unmount and ignores callbacks and rejections even when the producer ignores abort', async () => {
    const view = render(<FileBrowserPannel {...baseProps} />)
    view.unmount()
    emit(0, file('late.ckpt', '/old/late.ckpt'))
    await act(async () => requests[0].reject(new Error('Late unmount failure')))
    expect(mocks.notifyError).not.toHaveBeenCalled()
    expect(requests[0].stream.abortReceiver?.isAborted()).toBe(true)
  })

  it('invalidates callbacks before best-effort abort, including a throwing abort listener', async () => {
    const view = render(<FileBrowserPannel {...baseProps} />)
    requests[0].stream.abortReceiver?.onAbort(() => {
      requests[0].stream.onData({ file: file('aborted.ckpt', '/old/aborted.ckpt') })
      requests[0].reject(new Error('Aborted'))
      throw new Error('Transport abort failed')
    })
    expect(() => view.rerender(<FileBrowserPannel {...baseProps} dirPath="/new" />)).not.toThrow()
    await act(async () => undefined)
    expect(requests[0].stream.abortReceiver?.isAborted()).toBe(true)
    expect(screen.queryByText(/aborted\.ckpt|暂无Models/)).not.toBeInTheDocument()
    expect(mocks.notifyError).not.toHaveBeenCalled()
  })

  it('does not revive the first request when switching A to B to A', async () => {
    const view = render(<FileBrowserPannel {...baseProps} />)
    view.rerender(<FileBrowserPannel {...baseProps} dirPath="/new" />)
    view.rerender(<FileBrowserPannel {...baseProps} />)
    emit(0, file('stale.ckpt', '/old/stale.ckpt'))
    emit(1, file('stale-new.ckpt', '/new/stale-new.ckpt'))
    await act(async () => {
      requests[0].resolve()
      requests[1].reject(new Error('Stale B'))
    })
    expect(screen.queryByText(/stale|暂无Models/)).not.toBeInTheDocument()
    expect(mocks.notifyError).not.toHaveBeenCalled()
    emit(2, file('fresh.ckpt', '/old/fresh.ckpt'))
    expect(screen.getByText('fresh.ckpt')).toBeInTheDocument()
  })

  it.each(['rejection', 'synchronous throw'])(
    'handles a current list %s and exits loading',
    async (kind) => {
      if (kind === 'synchronous throw') {
        mocks.listComfyFiles.mockImplementation(() => {
          throw new Error('Current list failure')
        })
      }
      render(<FileBrowserPannel {...baseProps} />)
      await act(async () => {
        if (kind === 'rejection') requests[0].reject(new Error('Current list failure'))
      })
      expect(mocks.notifyError).toHaveBeenCalledExactlyOnceWith('The local file operation failed.')
      expect(screen.getByText('暂无Models')).toBeInTheDocument()
    }
  )

  it('ignores StrictMode replay callbacks while accepting the active stream', async () => {
    render(
      <StrictMode>
        <FileBrowserPannel {...baseProps} />
      </StrictMode>
    )
    expect(requests).toHaveLength(2)
    emit(0, file('replayed.ckpt', '/old/replayed.ckpt'))
    await act(async () => requests[0].reject(new Error('Replayed failure')))
    emit(1, file('active.ckpt', '/old/active.ckpt'))
    expect(screen.queryByText('replayed.ckpt')).not.toBeInTheDocument()
    expect(screen.getByText('active.ckpt')).toBeInTheDocument()
    expect(mocks.notifyError).not.toHaveBeenCalled()
  })
})
