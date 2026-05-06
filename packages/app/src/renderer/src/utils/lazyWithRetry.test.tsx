import React, { Suspense } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lazyWithRetry } from './lazyWithRetry'

class TestErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = {
    error: null
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return <div data-testid="lazy-error">{this.state.error.message}</div>
    }

    return this.props.children
  }
}

const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve()
  })
}

const renderLazyComponent = (LazyComponent: React.LazyExoticComponent<React.ComponentType>) =>
  render(
    <TestErrorBoundary>
      <Suspense fallback={<div>loading</div>}>
        <LazyComponent />
      </Suspense>
    </TestErrorBoundary>
  )

describe('lazyWithRetry', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('retries transient module fetch failures until the import succeeds', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const importer = vi
      .fn<() => Promise<{ default: React.ComponentType }>>()
      .mockRejectedValueOnce(
        new TypeError(
          'Failed to fetch dynamically imported module: http://localhost:5173/src/pages/ProjectCanvasPage/ProjectCanvasPage.tsx'
        )
      )
      .mockResolvedValue({
        default: () => <div>ready</div>
      })

    const LazyComponent = lazyWithRetry(importer, 1, 100)

    renderLazyComponent(LazyComponent)

    expect(screen.getByText('loading')).toBeInTheDocument()
    expect(importer).toHaveBeenCalledTimes(1)

    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(100)
    await flushMicrotasks()

    expect(importer).toHaveBeenCalledTimes(2)
    expect(screen.getByText('ready')).toBeInTheDocument()
  })

  it('retries the Vite error loading dynamically imported module variant', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const importer = vi
      .fn<() => Promise<{ default: React.ComponentType }>>()
      .mockRejectedValueOnce(
        new TypeError(
          'Error loading dynamically imported module: http://localhost:5173/src/pages/ProjectCanvasPage/ProjectCanvasPage.tsx'
        )
      )
      .mockResolvedValue({
        default: () => <div>loaded</div>
      })

    const LazyComponent = lazyWithRetry(importer, 1, 100)

    renderLazyComponent(LazyComponent)

    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(100)
    await flushMicrotasks()

    expect(importer).toHaveBeenCalledTimes(2)
    expect(screen.getByText('loaded')).toBeInTheDocument()
  })

  it('does not retry non-transient import failures', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const importer = vi
      .fn<() => Promise<{ default: React.ComponentType }>>()
      .mockRejectedValue(new SyntaxError('Unexpected token <'))

    const LazyComponent = lazyWithRetry(importer, 4, 100)

    renderLazyComponent(LazyComponent)

    await flushMicrotasks()

    expect(importer).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('lazy-error')).toHaveTextContent('Unexpected token <')
  })
})
