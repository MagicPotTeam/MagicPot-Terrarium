/**
 * Channel real-page test bed.
 *
 * Run with config/vitest/vitest.web.channel.config.mjs. Its first setup file
 * (test/channelDenyGuards.ts) refuses and counts fetch, XHR, WebSocket, EventSource, workers,
 * real IndexedDB, TCP sockets and every bridge call that a test did not list, and fails a test
 * that left a refusal behind.
 */
import {
  allowChannelBridge,
  allowChannelInMemoryIndexedDb,
  assertNoChannelDeniedAttempts,
  channelDeniedAttempts,
  channelGuardedGlobals,
  isChannelGuardDenied,
  repairReplacedChannelGuards,
  takeChannelDeniedAttempts,
  totalChannelDeniedAttempts
} from '../../test/channelDenyGuards'
import { describe, expect, it, vi } from 'vitest'
import { createFakeChatIndexedDb } from '../../testUtils/fakeChatIndexedDb'
import { loadSessionFromDB, saveSessionToDB, type ChatSession } from './chatStorage'

// Runs before every import of this file: the guards must already be installed by the setup file.
vi.hoisted(() => {
  if (!(globalThis as Record<symbol, unknown>)[Symbol.for('magicpot.channelDenyGuards.v1')]) {
    throw new Error(
      'ChatPage.channel.realPage.test.tsx must run with config/vitest/vitest.web.channel.config.mjs: the deny guards are not installed.'
    )
  }
})

// ---------------------------------------------------------------------------------------------
// The guards themselves
// ---------------------------------------------------------------------------------------------

describe('channel deny guards', () => {
  const denied = (kind: string, detail: string | RegExp) =>
    expect.objectContaining({
      kind,
      detail: typeof detail === 'string' ? detail : expect.stringMatching(detail)
    })

  it('refuses and counts a deliberate fetch', async () => {
    const before = totalChannelDeniedAttempts()
    expect(channelDeniedAttempts()).toEqual([])
    await expect(fetch('http://127.0.0.1:9/deliberate')).rejects.toSatisfy(isChannelGuardDenied)
    await expect(window.fetch(new URL('https://example.invalid/deliberate'))).rejects.toSatisfy(
      isChannelGuardDenied
    )
    expect(channelDeniedAttempts()).toHaveLength(2)
    expect(takeChannelDeniedAttempts()).toEqual([
      {
        kind: 'fetch',
        detail: 'http://127.0.0.1:9/deliberate',
        test: expect.stringContaining('deliberate fetch'),
        stack: expect.any(String)
      },
      denied('fetch', 'https://example.invalid/deliberate')
    ])
    expect(channelDeniedAttempts()).toEqual([])
    expect(totalChannelDeniedAttempts()).toBe(before + 2)
  })

  it('fails a test that leaves a refusal behind, and does not carry it into the next test', () => {
    void fetch('http://127.0.0.1:9/left-behind').catch(() => undefined)
    // The same check the setup file runs after every test.
    expect(() => assertNoChannelDeniedAttempts()).toThrow(
      /1 denied attempt\(s\) during the test:\n1\. fetch: http:\/\/127\.0\.0\.1:9\/left-behind/
    )
    expect(channelDeniedAttempts()).toEqual([])
    expect(() => assertNoChannelDeniedAttempts()).not.toThrow()
  })

  // Passes only because the afterEach of the setup file fails it: the body itself does not throw.
  it.fails('is failed by the setup file when a refusal is left behind', () => {
    void fetch('http://127.0.0.1:9/caught-by-the-setup-file').catch(() => undefined)
  })

  it('starts with an empty counter after a test that left a refusal behind', () => {
    expect(channelDeniedAttempts()).toEqual([])
  })

  it('counts a page that retries in a loop without keeping every call stack', () => {
    const before = totalChannelDeniedAttempts()
    for (let attempt = 0; attempt < 450; attempt += 1) {
      void fetch(`http://127.0.0.1:9/retry-${attempt}`).catch(() => undefined)
    }
    expect(totalChannelDeniedAttempts()).toBe(before + 450)
    const kept = takeChannelDeniedAttempts()
    expect(kept).toHaveLength(201)
    expect(kept[199].detail).toBe('http://127.0.0.1:9/retry-199')
    expect(kept[200].detail).toBe('... and 250 more refusal(s) that were counted but not kept')
    expect(channelDeniedAttempts()).toEqual([])
  })

  it('refuses XHR, WebSocket, EventSource and workers on both globals', () => {
    const globals = channelGuardedGlobals() as Array<
      Record<string, new (...args: unknown[]) => unknown>
    >
    // The Node global the tests call `window`, and the jsdom window underneath it.
    expect(globals).toHaveLength(2)
    expect(globals[0]).toBe(globalThis)
    expect(globals[1]).toBe((globalThis as unknown as { jsdom: { window: unknown } }).jsdom.window)
    expect(document.defaultView).toBe(globalThis)
    for (const target of globals) {
      expect(() => new target.XMLHttpRequest()).toThrow(/refused xhr/)
      expect(() => new target.WebSocket('ws://127.0.0.1:9/socket')).toThrow(/refused websocket/)
      expect(() => new target.EventSource('http://127.0.0.1:9/events')).toThrow(
        /refused eventsource/
      )
      expect(() => new target.Worker('worker.js')).toThrow(/refused worker/)
      expect(() => new target.SharedWorker('worker.js')).toThrow(/refused worker/)
      expect(navigator.sendBeacon('http://127.0.0.1:9/beacon')).toBe(false)
    }
    expect(takeChannelDeniedAttempts().map((attempt) => attempt.kind)).toEqual([
      ...['xhr', 'websocket', 'eventsource', 'worker', 'worker', 'beacon'],
      ...['xhr', 'websocket', 'eventsource', 'worker', 'worker', 'beacon']
    ])
  })

  it('refuses TCP below the page: node sockets, node:http(s) loaded later, and listening', async () => {
    const net = await import('node:net')
    const http = await import('node:http')
    const https = await import('node:https')
    const failure = (start: (fail: (error: Error) => void) => void): Promise<Error> =>
      new Promise((resolve) => start(resolve))
    expect(await failure((fail) => net.connect(9, '127.0.0.1').once('error', fail))).toSatisfy(
      isChannelGuardDenied
    )
    expect(
      await failure((fail) => http.get('http://127.0.0.1:9/node-http').once('error', fail))
    ).toSatisfy(isChannelGuardDenied)
    expect(
      await failure((fail) => https.get('https://127.0.0.1:9/node-https').once('error', fail))
    ).toSatisfy(isChannelGuardDenied)
    expect(() => http.createServer().listen(0, '127.0.0.1')).toThrow(/refused socket/)
    expect(takeChannelDeniedAttempts()).toEqual([
      denied('socket', 'net.Socket.connect(127.0.0.1:9)'),
      denied('socket', /^net\.Socket\.connect\(127\.0\.0\.1:9\)$/),
      denied('socket', /^net\.Socket\.connect\(127\.0\.0\.1:9\)$/),
      denied('socket', 'net.Server.listen()')
    ])
  })

  it('refuses a request from a third global (an iframe window) at the transport', async () => {
    const frame = document.body.appendChild(document.createElement('iframe'))
    try {
      const FrameXhr = (frame.contentWindow as unknown as { XMLHttpRequest: typeof XMLHttpRequest })
        .XMLHttpRequest
      // Not one of the guarded globals: the page-level guard is not on it ...
      expect(channelGuardedGlobals()).not.toContain(frame.contentWindow)
      const xhr = new FrameXhr()
      const ended = new Promise<string>((resolve) => {
        xhr.onerror = () => resolve('error')
        xhr.onload = () => resolve('load')
      })
      xhr.open('GET', 'http://127.0.0.1:9/from-an-iframe')
      xhr.send()
      // ... so the socket underneath refuses it.
      expect(await ended).toBe('error')
      expect(takeChannelDeniedAttempts()).toEqual([
        denied('socket', 'net.Socket.connect(127.0.0.1:9)')
      ])
    } finally {
      frame.remove()
    }
  })

  it('refuses IndexedDB unless the test allows an in-memory fake, and forgets the fake afterwards', async () => {
    expect(() => indexedDB.open('magicpot-chat')).toThrow(/refused indexeddb/)
    await expect(indexedDB.databases()).rejects.toSatisfy(isChannelGuardDenied)
    expect(takeChannelDeniedAttempts()).toEqual([
      denied('indexeddb', 'indexedDB.open(magicpot-chat)'),
      denied('indexeddb', 'indexedDB.databases()')
    ])
    const fake = createFakeChatIndexedDb()
    // The fake cannot be put on the global directly ...
    expect(() => fake.install((name, value) => vi.stubGlobal(name, value))).toThrow(TypeError)
    // ... only through the guards, for this test.
    fake.install((_name, value) => allowChannelInMemoryIndexedDb(value))
    await saveSessionToDB(
      { id: 'in-memory', title: 'in-memory', messages: [] } as ChatSession,
      'guard-self-test'
    )
    expect((await loadSessionFromDB('in-memory', 'guard-self-test'))?.title).toBe('in-memory')
    expect(channelDeniedAttempts()).toEqual([])
  })

  it('refuses IndexedDB again in the next test', () => {
    expect(() => indexedDB.open('magicpot-chat')).toThrow(/refused indexeddb/)
    expect(takeChannelDeniedAttempts()).toHaveLength(1)
  })

  it('refuses every bridge call that the test did not list', async () => {
    const bridge = window.api as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
    // Reading and feature-testing a bridge is not a call.
    expect(typeof bridge.svcFs.readFileFromPath).toBe('function')
    expect('svcFs' in bridge).toBe(true)
    expect(bridge.svcFs).toBe(bridge.svcFs)
    expect(channelDeniedAttempts()).toEqual([])

    await expect(bridge.svcFs.readFileFromPath({ fullPath: '/etc/hosts' })).rejects.toSatisfy(
      isChannelGuardDenied
    )
    const listed = vi.fn(async () => ({ jobs: [] }))
    allowChannelBridge('api', { svcLLMProxy: { listAgentJobs: listed } })
    await expect(bridge.svcLLMProxy.listAgentJobs({ conversationId: 'lead' })).resolves.toEqual({
      jobs: []
    })
    expect(listed).toHaveBeenCalledWith({ conversationId: 'lead' })
    // A listed neighbour does not open the rest of the service, or the other bridges.
    await expect(bridge.svcLLMProxy.chat({ messages: [] })).rejects.toSatisfy(isChannelGuardDenied)
    const others = window as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => unknown>
    >
    await expect(others.win.minimize()).rejects.toSatisfy(isChannelGuardDenied)
    await expect(others.appEvents.onCloseActiveTab(() => undefined)).rejects.toSatisfy(
      isChannelGuardDenied
    )
    await expect(others.electronFile.getPathForFile({})).rejects.toSatisfy(isChannelGuardDenied)
    expect(
      takeChannelDeniedAttempts().map((attempt) => `${attempt.kind}: ${attempt.detail}`)
    ).toEqual([
      'bridge: api.svcFs.readFileFromPath',
      'bridge: api.svcLLMProxy.chat',
      'bridge: win.minimize',
      'bridge: appEvents.onCloseActiveTab',
      'bridge: electronFile.getPathForFile'
    ])
  })

  it('forgets listed bridge calls in the next test', async () => {
    const bridge = window.api as unknown as Record<
      string,
      Record<string, (...args: unknown[]) => Promise<unknown>>
    >
    await expect(bridge.svcLLMProxy.listAgentJobs({ conversationId: 'lead' })).rejects.toSatisfy(
      isChannelGuardDenied
    )
    expect(takeChannelDeniedAttempts()).toEqual([denied('bridge', 'api.svcLLMProxy.listAgentJobs')])
  })

  it('cannot be replaced: assignment is refused, redefinition throws or is restored', () => {
    const guardedFetch = globalThis.fetch
    const guardedApi = window.api
    const replacement = vi.fn()
    ;(globalThis as { fetch: unknown }).fetch = replacement
    ;(window as { api: unknown }).api = { svcLLMProxy: { chat: replacement } }
    expect(globalThis.fetch).toBe(guardedFetch)
    expect(window.api).toBe(guardedApi)
    expect(() => vi.stubGlobal('fetch', replacement)).toThrow(TypeError)
    expect(() => Object.defineProperty(window, 'api', { configurable: true, value: {} })).toThrow(
      TypeError
    )
    expect(() => {
      ;(window.api as unknown as Record<string, unknown>).svcLLMProxy = {}
    }).toThrow(TypeError)
    expect(
      takeChannelDeniedAttempts().map((attempt) => `${attempt.kind}: ${attempt.detail}`)
    ).toEqual([
      'guard-replaced: assignment to globalThis.fetch',
      'guard-replaced: assignment to globalThis.api',
      'guard-replaced: write to api.svcLLMProxy'
    ])

    // jsdom-owned names must stay deletable for the environment teardown, so a redefinition is
    // possible there; the end-of-test check reports it and puts the guard back.
    const guardedXhr = globalThis.XMLHttpRequest
    vi.stubGlobal('XMLHttpRequest', class {})
    expect(globalThis.XMLHttpRequest).not.toBe(guardedXhr)
    expect(() => assertNoChannelDeniedAttempts()).toThrow(
      /guards were replaced during the test: globalThis\.XMLHttpRequest/
    )
    expect(globalThis.XMLHttpRequest).toBe(guardedXhr)
    vi.unstubAllGlobals()
    expect(repairReplacedChannelGuards()).toEqual([])
    expect(globalThis.XMLHttpRequest).toBe(guardedXhr)
    expect(replacement).not.toHaveBeenCalled()
  })

  it('shares one counter with a second copy of the guard module', async () => {
    vi.resetModules()
    const again = await import('../../test/channelDenyGuards')
    expect(again.takeChannelDeniedAttempts).not.toBe(takeChannelDeniedAttempts)
    void fetch('http://127.0.0.1:9/second-copy').catch(() => undefined)
    expect(again.channelDeniedAttempts()).toHaveLength(1)
    expect(takeChannelDeniedAttempts()).toEqual([denied('fetch', 'http://127.0.0.1:9/second-copy')])
    expect(again.channelDeniedAttempts()).toEqual([])
  })
})
