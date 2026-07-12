import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileTreeRoot } from './ModelPage'

const listDirShallow = vi.fn()
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcHyper: { listDirShallow } })
}))
vi.mock('@renderer/hooks/useConfig', () => ({ useConfig: () => ({ configUtils: {} }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./FileBrowserPannel', () => ({ default: () => null }))
vi.mock('@renderer/assets/whitehu.png', () => ({ default: '' }))

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function entry(name: string, path: string) {
  return { name, path, isDirectory: false }
}

describe('FileTreeRoot', () => {
  it('resets on rootDir changes and ignores the old directory result', async () => {
    const oldRequest = deferred<{ entries: ReturnType<typeof entry>[] }>()
    const newRequest = deferred<{ entries: ReturnType<typeof entry>[] }>()
    listDirShallow.mockImplementation(({ dir }: { dir: string }) =>
      dir === '/old' ? oldRequest.promise : newRequest.promise
    )

    const { rerender } = render(<FileTreeRoot rootDir="/old" rootLabel="old" />)
    rerender(<FileTreeRoot rootDir="/new" rootLabel="new" />)

    expect(screen.getByText('new')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()

    await act(async () => newRequest.resolve({ entries: [entry('new-file', '/new/new-file')] }))
    expect(screen.getByText('new-file')).toBeInTheDocument()

    await act(async () => oldRequest.resolve({ entries: [entry('old-file', '/old/old-file')] }))
    expect(screen.getByText('new-file')).toBeInTheDocument()
    expect(screen.queryByText('old-file')).not.toBeInTheDocument()
  })
})
