import React, { useLayoutEffect } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { ConfigProvider, useConfig } from './useConfig'
import { useConfigObservation } from './configObservationContext'

type State = { config: Config; buildEnv: typeof DEFAULT_BUILD_ENV; isReady: boolean }
type Update = (previous: State) => State
const h = vi.hoisted(() => ({
  api: vi.fn(), get: vi.fn(), build: vi.fn(), watch: vi.fn(), save: vi.fn(),
  queued: [] as Array<{ update: Update; set: (update: Update) => void }>,
  applied: [] as Array<{ previous: State; next: State }>
}))
// Scheduler harness ONLY: hold this provider's config-state setters, then deliver its REAL
// functional updaters through React after observations have advanced. Not native scheduling proof.
vi.mock('react', async original => {
  const react = await original<typeof import('react')>()
  const useState = ((initial: unknown) => {
    const [state, set] = react.useState(initial)
    if (initial && typeof initial === 'object' && Object.hasOwn(initial, 'config') && Object.hasOwn(initial, 'buildEnv') && Object.hasOwn(initial, 'isReady')) {
      return [state, (update: Update) => { h.queued.push({ update, set: set as (update: Update) => void }) }]
    }
    return [state, set]
  }) as typeof react.useState
  return { ...react, useState }
})
vi.mock('@renderer/utils/windowUtils', () => ({ api: h.api }))
let onData: ((data: { config: Config }) => void) | undefined, delivering = false, nested = false
function Probe() {
  const source = useConfigObservation(), state = useConfig()
  useLayoutEffect(() => source.subscribe(() => { if (delivering && !nested) { nested = true; onData?.({ config: { ...DEFAULT_CONFIG, download_dir: 'newer-forced' } }) } }), [source])
  return <div>{state.isReady ? `${state.config.download_dir}/${state.buildEnv.env.packageVersion}` : 'notready'}</div>
}
beforeEach(() => { vi.clearAllMocks(); h.queued.length = 0; h.applied.length = 0; onData = undefined; delivering = false; nested = false })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('actual provider updater under a bounded deferred-state scheduler harness', () => {
  it('demonstrably rejects stale queued initialization and the latest watch ALONE supplies initialized build/readiness', async () => {
    const build = { ...DEFAULT_BUILD_ENV, env: { ...DEFAULT_BUILD_ENV.env, packageVersion: 'forced-build' } }
    h.get.mockResolvedValue({ config: { ...DEFAULT_CONFIG, download_dir: 'initial-forced' } }); h.build.mockResolvedValue({ buildEnv: build })
    h.api.mockReturnValue({ svcState: { getConfig: h.get, getBuildEnv: h.build, watchConfig: h.watch, saveConfig: h.save } })
    h.watch.mockImplementation((_request, response) => { onData = response.onData; delivering = true; onData?.({ config: { ...DEFAULT_CONFIG, download_dir: 'older-forced' } }); delivering = false; return new Promise(() => {}) })
    render(<ConfigProvider><Probe /></ConfigProvider>); await waitFor(() => expect(h.watch).toHaveBeenCalledOnce())
    expect(nested).toBe(true); expect(screen.getByText('notready')).toBeInTheDocument(); expect(h.queued).toHaveLength(2)
    const queued = h.queued.splice(0)
    act(() => { for (const item of queued) item.set(previous => { const next = item.update(previous); h.applied.push({ previous, next }); return next }) })
    expect(h.applied.length).toBeGreaterThanOrEqual(2)
    const initialization = h.applied[0]
    expect(initialization.previous.isReady).toBe(false); expect(initialization.previous.buildEnv).toBe(DEFAULT_BUILD_ENV)
    expect(initialization.next).toBe(initialization.previous) // Directly establishes rejected initialization updater.
    const latest = h.applied.at(-1)!
    expect(latest.next.isReady).toBe(true); expect(latest.next.buildEnv).toBe(build); expect(latest.next.config.download_dir).toBe('newer-forced')
    expect(screen.getByText('newer-forced/forced-build')).toBeInTheDocument()
    expect(h.get).toHaveBeenCalledOnce(); expect(h.build).toHaveBeenCalledOnce(); expect(h.watch).toHaveBeenCalledOnce(); expect(h.api).toHaveBeenCalledTimes(3); expect(h.save).not.toHaveBeenCalled()
  })
})
