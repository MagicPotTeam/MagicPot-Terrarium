import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import zhLocale from '@shared/locales/zh-CN/renderer.json'
import { MessageProvider, useMessage } from '@renderer/hooks/useMessage'
import { AgentColumnToastContext } from '@renderer/hooks/agentColumnToastContext'
import { useAgentColumnToasts } from './AgentColumnToasts'

const translate = (key: string) => {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      zhLocale
    )
  return typeof value === 'string' ? value : key
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }))

let notify: ReturnType<typeof useMessage>
function Raiser() {
  notify = useMessage()
  return null
}

function Column({ children }: { children?: React.ReactNode }) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { sink, stack } = useAgentColumnToasts(rootRef)
  return (
    <AgentColumnToastContext.Provider value={sink}>
      <div ref={rootRef} data-testid="column">
        {children}
        {stack}
      </div>
    </AgentColumnToastContext.Provider>
  )
}

const renderColumn = () =>
  render(
    <MessageProvider>
      <Column>
        <Raiser />
      </Column>
    </MessageProvider>
  )

const toasts = () => screen.queryAllByTestId('agent-column-toast')

afterEach(() => {
  vi.useRealTimers()
})

describe('Agent column toasts', () => {
  it('shows a message raised in the column at its top with the severity word and a dismiss button', () => {
    renderColumn()
    act(() => {
      notify.notifyWarning('团队状态冲突，已保留本地更改')
    })
    const stack = screen.getByRole('region', { name: '通知' })
    expect(screen.getByTestId('column')).toContainElement(stack)
    const [toast] = toasts()
    expect(stack).toContainElement(toast)
    expect(toast).toHaveAttribute('role', 'alert')
    expect(toast).toHaveTextContent(/^警告：团队状态冲突，已保留本地更改×$/)
    expect(getComputedStyle(toast).borderLeftWidth).toBe('3px')
    expect(getComputedStyle(toast).borderRadius).toBe('4px')
    expect(getComputedStyle(stack).top).toBe('8px')
    act(() => {
      notify.notifyInfo('已复制')
    })
    expect(toasts()[1]).toHaveAttribute('role', 'status')
    expect(toasts()[1]).toHaveTextContent(/^提示：已复制/)
    act(() => {
      notify.notifyError('保存失败')
    })
    expect(toasts()[2]).toHaveTextContent(/^错误：保存失败/)
    fireEvent.click(within(toasts()[0]).getByRole('button', { name: '关闭通知' }))
    expect(toasts().map((item) => item.textContent)).toEqual(['提示：已复制×', '错误：保存失败×'])
    // Nothing went to the app-wide snackbar.
    expect(document.querySelector('.notistack-SnackbarContainer [role="alert"]')).toBeNull()
  })

  it('goes after 4 s, keeps a given duration, and pauses while hovered', () => {
    vi.useFakeTimers()
    renderColumn()
    act(() => {
      notify.notifyInfo('短消息')
      notify.notifyInfo('六秒消息', 6000)
    })
    act(() => {
      vi.advanceTimersByTime(3999)
    })
    expect(toasts()).toHaveLength(2)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(toasts().map((item) => item.textContent)).toEqual(['提示：六秒消息×'])
    fireEvent.mouseEnter(toasts()[0])
    act(() => {
      vi.advanceTimersByTime(10000)
    })
    expect(toasts()).toHaveLength(1)
    // Leaving restarts a full interval.
    fireEvent.mouseLeave(toasts()[0])
    act(() => {
      vi.advanceTimersByTime(5999)
    })
    expect(toasts()).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(toasts()).toHaveLength(0)
  })

  it('keeps at most five, drops the oldest, and does not repeat a message that is shown', () => {
    renderColumn()
    act(() => {
      for (let index = 1; index <= 6; index += 1) notify.notifyInfo(`消息 ${index}`)
      notify.notifyInfo('消息 6')
    })
    expect(toasts().map((item) => item.textContent)).toEqual([
      '提示：消息 2×',
      '提示：消息 3×',
      '提示：消息 4×',
      '提示：消息 5×',
      '提示：消息 6×'
    ])
  })

  it('keeps a sticky message until it is dismissed and closes on Escape', () => {
    vi.useFakeTimers()
    renderColumn()
    act(() => {
      notify.notifyError('需要处理', null)
    })
    act(() => {
      vi.advanceTimersByTime(120000)
    })
    const [toast] = toasts()
    expect(toast).toBeInTheDocument()
    fireEvent.keyDown(within(toast).getByRole('button'), { key: 'Escape' })
    expect(toasts()).toHaveLength(0)
  })

  it('still suppresses success messages and transient capacity errors', () => {
    renderColumn()
    act(() => {
      notify.notifySuccess('完成')
      notify.notifyError('The server is overloaded')
    })
    expect(toasts()).toHaveLength(0)
  })

  it('leaves the message to the app-wide snackbar while a dialog covers the app', () => {
    renderColumn()
    const dialog = document.createElement('div')
    dialog.className = 'MuiDialog-root'
    document.body.append(dialog)
    try {
      act(() => {
        notify.notifyError('历史记录读取失败')
      })
      expect(toasts()).toHaveLength(0)
      expect(screen.getByText('历史记录读取失败')).toBeInTheDocument()
    } finally {
      dialog.remove()
    }
  })

  it('leaves messages raised outside the column to the app-wide snackbar', () => {
    render(
      <MessageProvider>
        <Column />
        <Raiser />
      </MessageProvider>
    )
    act(() => {
      notify.notifyWarning('画布消息')
    })
    expect(toasts()).toHaveLength(0)
    expect(screen.getByText('画布消息')).toBeInTheDocument()
  })
})
