import React, { StrictMode, useLayoutEffect } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { ConfigProvider, useConfig } from './useConfig'
import { useConfigObservation } from './configObservationContext'
import { unavailableConfigObservation, type ConfigObservationSource } from './configObservation'

const h = vi.hoisted(() => ({ api: vi.fn(), get: vi.fn(), build: vi.fn(), watch: vi.fn(), save: vi.fn() }))
vi.mock('@renderer/utils/windowUtils', () => ({ api: h.api }))
const callbacks: Array<(data: { config: Config }) => void> = []
let observation: ConfigObservationSource, renderedConfig: Config, renderedReady: boolean, renderedBuild = DEFAULT_BUILD_ENV
function Probe({ name = 'ready' }: { name?: string }) {
  observation = useConfigObservation()
  const context = useConfig(); renderedConfig = context.config; renderedReady = context.isReady; renderedBuild = context.buildEnv
  return <div data-testid={name}>{context.isReady ? context.config.download_dir || 'ready' : 'pending'}</div>
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const config = (name = 'initial'): Config => ({ ...DEFAULT_CONFIG, download_dir: name })
const waitForWatch = () => waitFor(() => expect(h.watch).toHaveBeenCalledOnce())
beforeEach(() => {
  vi.clearAllMocks(); callbacks.length = 0; observation = unavailableConfigObservation
  h.api.mockReturnValue({ svcState: { getConfig: h.get, getBuildEnv: h.build, watchConfig: h.watch, saveConfig: h.save } })
  h.get.mockResolvedValue({ config: config() }); h.build.mockResolvedValue({ buildEnv: DEFAULT_BUILD_ENV })
  h.watch.mockImplementation((_request, response) => { callbacks.push(response.onData); return new Promise(() => {}) })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('actual ConfigProvider passive observation — existing config stream only, not effective MAIN enablement', () => {
  it('missing provider returns stable notready without a service read or notification', () => {
    render(<Probe />); expect(observation).toBe(unavailableConfigObservation)
    expect(observation.getSnapshot()).toEqual({ ready: false, generation: 0 }); expect(h.api).not.toHaveBeenCalled()
  })
  it('initial readiness advances only the provider-owned observation and never starts an extra probe/watch/save', async () => {
    render(<ConfigProvider><Probe /></ConfigProvider>); await waitForWatch()
    expect(observation).not.toBe(unavailableConfigObservation); expect(observation.getSnapshot()).toEqual({ ready: true, generation: 1 })
    expect(h.get).toHaveBeenCalledExactlyOnceWith({}); expect(h.build).toHaveBeenCalledExactlyOnceWith({}); expect(h.watch.mock.calls[0]?.[0]).toEqual({})
    expect(h.api).toHaveBeenCalledTimes(3); expect(h.save).not.toHaveBeenCalled(); expect(renderedReady).toBe(true)
  })
  it('publishes observation synchronously BEFORE React state for every watch message, including same-ref and batched disable→enable ABA', async () => {
    render(<ConfigProvider><Probe /></ConfigProvider>); await waitForWatch()
    const source = observation, initial = source.getSnapshot(), seen: Array<{ snapshot: unknown; rendered: Config }> = []
    const unsubscribe = source.subscribe(() => { seen.push({ snapshot: source.getSnapshot(), rendered: renderedConfig }) })
    const same = renderedConfig, disabled = { ...same, magic_agent_platform_config: { enabled: false } }, enabled = { ...same, magic_agent_platform_config: { enabled: true } }
    act(() => { callbacks[0]({ config: disabled }); expect(seen).toHaveLength(1); callbacks[0]({ config: enabled }); callbacks[0]({ config: enabled }); expect(seen).toHaveLength(3); expect(renderedConfig).toBe(same) })
    expect(source.getSnapshot()).toEqual({ ready: true, generation: initial.generation + 3 })
    expect(seen.map(item => item.rendered)).toEqual([same, same, same]); expect(renderedConfig).toBe(enabled); expect(observation).toBe(source)
    expect(h.api).toHaveBeenCalledTimes(3); expect(h.watch).toHaveBeenCalledOnce(); expect(h.save).not.toHaveBeenCalled(); unsubscribe()
  })
  it('marks the observation notready BEFORE abort callbacks and ignores retained onData after cleanup', async () => {
    const view = render(<ConfigProvider><Probe /></ConfigProvider>); await waitForWatch()
    const source = observation, initial = source.getSnapshot(), atAbort = vi.fn(() => { expect(source.getSnapshot().ready).toBe(false); expect(source.getSnapshot().generation).toBe(initial.generation + 1) })
    h.watch.mock.calls[0][1].abortReceiver.onAbort(atAbort)
    view.unmount(); expect(atAbort).toHaveBeenCalledOnce(); const disposed = source.getSnapshot()
    act(() => callbacks[0]({ config: config('obsolete') }))
    expect(source.getSnapshot()).toBe(disposed); expect(h.get).toHaveBeenCalledOnce(); expect(h.watch).toHaveBeenCalledOnce()
  })
  it('does not publish late initialization and never starts its watch after unmount', async () => {
    const pending = deferred<{ config: Config }>(); h.get.mockReturnValueOnce(pending.promise)
    const view = render(<ConfigProvider><Probe /></ConfigProvider>), source = observation
    expect(source.getSnapshot().ready).toBe(false); view.unmount(); const disposed = source.getSnapshot()
    await act(async () => pending.resolve({ config: config('obsolete') }))
    expect(source.getSnapshot()).toBe(disposed); expect(source.getSnapshot().ready).toBe(false); expect(h.watch).not.toHaveBeenCalled()
  })
  it('StrictMode stale initialization cannot notify or replace the current provider generation', async () => {
    const pending = deferred<{ config: Config }>(); h.get.mockReturnValueOnce(pending.promise)
    render(<StrictMode><ConfigProvider><Probe /></ConfigProvider></StrictMode>); await waitForWatch()
    const source = observation, snapshot = source.getSnapshot(), listener = vi.fn(); source.subscribe(listener)
    expect(snapshot.ready).toBe(true); expect(h.get).toHaveBeenCalledTimes(2); expect(h.build).toHaveBeenCalledTimes(2); expect(h.watch).toHaveBeenCalledOnce()
    await act(async () => pending.resolve({ config: config('obsolete') }))
    expect(source.getSnapshot()).toBe(snapshot); expect(listener).not.toHaveBeenCalled(); expect(screen.getByTestId('ready')).toHaveTextContent('initial')
  })
  it('a throwing observer neither blocks the existing context update nor another observer', async () => {
    render(<ConfigProvider><Probe /></ConfigProvider>); await waitForWatch()
    const source = observation, bad = vi.fn(() => { throw new Error('RAW_OBSERVER') }), good = vi.fn(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
    source.subscribe(bad); source.subscribe(good); act(() => callbacks[0]({ config: config('next') }))
    expect(bad).toHaveBeenCalledOnce(); expect(good).toHaveBeenCalledOnce(); expect(screen.getByTestId('ready')).toHaveTextContent('next'); expect(log).not.toHaveBeenCalled()
  })
  it('observer reentry into a newer onData cannot let the outer older message overwrite current config', async () => {
    render(<ConfigProvider><Probe /></ConfigProvider>); await waitForWatch()
    let nested = false
    observation.subscribe(() => { if (!nested) { nested = true; callbacks[0]({ config: config('newer') }) } })
    act(() => callbacks[0]({ config: config('older') }))
    expect(screen.getByTestId('ready')).toHaveTextContent('newer'); expect(observation.getSnapshot().generation).toBeGreaterThanOrEqual(3)
  })
  it('immediate nested watch delivery supersedes queued initialization without losing non-default buildEnv or readiness', async () => {
    const build = { ...DEFAULT_BUILD_ENV, env: { ...DEFAULT_BUILD_ENV.env, packageVersion: 'immediate-watch-fixture' } }
    h.build.mockResolvedValueOnce({ buildEnv: build })
    let delivering = false, nested = false, readyAtDelivery: boolean | undefined
    function ImmediateObserver() {
      const source = useConfigObservation()
      useLayoutEffect(() => source.subscribe(() => {
        if (delivering && !nested) { nested = true; callbacks[0]({ config: config('newer-immediate') }) }
      }), [source])
      return <Probe />
    }
    h.watch.mockImplementationOnce((_request, response) => {
      callbacks.push(response.onData); readyAtDelivery = renderedReady; delivering = true
      response.onData({ config: config('older-immediate') }); delivering = false
      return new Promise(() => {})
    })
    render(<ConfigProvider><ImmediateObserver /></ConfigProvider>); await waitForWatch()
    expect(readyAtDelivery).toBe(false); expect(nested).toBe(true)
    expect(screen.getByTestId('ready')).toHaveTextContent('newer-immediate'); expect(renderedReady).toBe(true); expect(renderedBuild).toBe(build)
    expect(observation.getSnapshot()).toEqual({ ready: true, generation: 3 })
    expect(h.get).toHaveBeenCalledOnce(); expect(h.build).toHaveBeenCalledOnce(); expect(h.watch).toHaveBeenCalledOnce(); expect(h.api).toHaveBeenCalledTimes(3); expect(h.save).not.toHaveBeenCalled()
  })
  it('unmount/remount uses different provider source identity and old callbacks/disposer cannot mutate successor', async () => {
    const first = render(<ConfigProvider><Probe /></ConfigProvider>); await waitForWatch(); const old = observation, dispose = old.subscribe(vi.fn()), oldCallback = callbacks[0]
    first.unmount(); h.watch.mockClear(); render(<ConfigProvider><Probe /></ConfigProvider>); await waitForWatch()
    const next = observation, snapshot = next.getSnapshot(); expect(next).not.toBe(old); dispose(); dispose()
    act(() => oldCallback({ config: config('obsolete') }))
    expect(next.getSnapshot()).toBe(snapshot); expect(screen.getByTestId('ready')).toHaveTextContent('initial')
  })
})
