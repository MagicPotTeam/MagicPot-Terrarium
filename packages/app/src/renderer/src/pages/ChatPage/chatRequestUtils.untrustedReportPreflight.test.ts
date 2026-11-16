import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type CustomSkill } from '@shared/config/config'
import type { ChatMessage } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'
import { UNVERIFIED_REPORT_BUNDLE_MESSAGE } from '@shared/llm/unverifiedReport'
import { createReportBundleRegistryFixture } from './__fixtures__/reportBundleFixtures'

const agent: CustomSkill = { id: 'fixture', type: 'agent', category: 'fixture', skillName: 'Fixture', prompt: 'Analyze', apiAddress: 'https://synthetic.invalid', apiKey: '' }
const config: Config = { ...DEFAULT_CONFIG, use_remote_llm: false, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [{ id: 'fixture-profile', provider: 'openai', deployment: 'cloud', model_use: 'chat', model_name: 'fixture-model', base_url: 'https://synthetic.invalid/v1', api_key: 'synthetic', api_mode: 'chat-completions', attachment_transports: ['request-data-url', 'accessible-url'] }] } }
const primary = (extra: Record<string, unknown> = {}) => ({ type: 'file' as const, url: 'data:text/plain;base64,QQ==', fileName: 'report.txt', reportBundleRole: 'primary-report' as const, ...extra })
const picture = { type: 'image' as const, url: 'local-media:///synthetic/image.png', mimeType: 'image/png' }
function fixture() {
  const fetch = vi.fn(async () => new Response('synthetic', { headers: { 'content-type': 'text/plain' } }))
  const materialize = vi.fn()
  const chat = vi.fn(async () => ({ content: 'synthetic' }))
  const chatStream = vi.fn(async (_payload, receiver: { onData: (event: unknown) => void }) => receiver.onData({ type: 'done', content: 'synthetic' }))
  const remoteFetch = vi.fn(async () => ({ status: 200, statusText: 'OK', body: JSON.stringify({ content: 'synthetic' }) }))
  const externalAgentStream = vi.fn(async (_payload, receiver: { onData: (event: unknown) => void }) => receiver.onData({ type: 'done', content: 'synthetic' }))
  vi.stubGlobal('fetch', fetch)
  window.api = { svcManagedMedia: { materializeForRequest: materialize }, svcLLMProxy: { chat, chatStream, remoteFetch, externalAgentStream } } as unknown as Window['api']
  return { fetch, materialize, chat, chatStream, remoteFetch, externalAgentStream }
}
function run(messages: ChatMessage[], stream = false, external = false, latest = false) {
  const input = { config, messages, profileId: 'fixture-profile', ...(external ? { externalAgentSkill: agent } : {}), ...(latest ? { imageHistoryPolicy: 'latest-user-turn' as const } : {}) }
  return stream ? requestChatCompletionStream({ ...input, onEvent: vi.fn() }) : requestChatCompletion(input)
}
beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('unverified primary-report request preflight', () => {
  it.each([
    ['missing manifest', {}, false, false, false],
    ['self claimed hint', { reportBundleId: 'claimed', reportBundleImageCount: 1 }, false, false, true],
    ['present manifest', { reportBundleManifestUrl: 'local-media:///synthetic/manifest.json', reportBundleId: 'claimed', reportBundleImageCount: 1 }, true, false, true],
    ['external route', { reportBundleManifestUrl: 'local-media:///synthetic/manifest.json' }, false, true, false],
    ['external streaming', {}, true, true, true]
  ] as const)('rejects %s before I/O', async (_name, metadata, stream, external, withImage) => {
    const f = fixture()
    const messages: ChatMessage[] = [{ role: 'user', content: 'synthetic', attachments: [primary(metadata), ...(withImage ? [picture] : [])] }]
    const before = JSON.stringify(messages)
    await expect(run(messages, stream, external)).rejects.toThrow()
    expect(JSON.stringify(messages)).toBe(before)
    for (const fn of Object.values(f)) expect(fn).not.toHaveBeenCalled()
  })
  it('rejects an old primary file even under latest-user-turn image policy', async () => {
    const f = fixture()
    const messages: ChatMessage[] = [{ role: 'user', content: 'old', attachments: [primary({ reportBundleManifestUrl: 'local-media:///synthetic/manifest.json' }), picture] }, { role: 'user', content: 'new' }]
    const before = JSON.stringify(messages)
    await expect(run(messages, false, false, true)).rejects.toThrow()
    expect(JSON.stringify(messages)).toBe(before)
    for (const fn of Object.values(f)) expect(fn).not.toHaveBeenCalled()
  })
  it('allows an ordinary file without a report role', async () => {
    const f = fixture()
    const messages: ChatMessage[] = [{ role: 'user', content: 'synthetic', attachments: [{ type: 'file', url: 'data:text/plain;base64,QQ==', fileName: 'ordinary.txt', mimeType: 'text/plain' }] }]
    await expect(run(messages)).resolves.toBeDefined()
    expect(f.chat).toHaveBeenCalledOnce()
  })
  it('allows a message already projected without the report attachment', async () => {
    const f = fixture()
    const projected: ChatMessage[] = [{ role: 'user', content: 'synthetic' }]
    await expect(run(projected)).resolves.toBeDefined()
    expect(f.chat).toHaveBeenCalledOnce()
  })
})

describe('registered primary-report request verification', () => {
  const conversationId = 'bound-report-owner'
  const routes = [
    ['unary', false, false],
    ['stream', true, false],
    ['external unary', false, true],
    ['external stream', true, true]
  ] as const
  const managedMedia = {
    version: 1 as const,
    kind: 'managed' as const,
    relativePath: `originals/aa/${'a'.repeat(64)}.txt`,
    mimeType: 'text/plain',
    sizeBytes: 1,
    sha256: 'a'.repeat(64)
  }
  function boundFixture(service: 'registry' | 'missing' | 'rejecting' = 'registry') {
    const f = fixture()
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('synthetic', { headers: { 'content-type': 'text/plain' } })
    )
    vi.stubGlobal('fetch', fetch)
    const reports = createReportBundleRegistryFixture()
    if (service === 'rejecting')
      reports.verify.mockRejectedValue(new Error('synthetic IPC failure'))
    if (service !== 'missing')
      (window.api as unknown as Record<string, unknown>).svcReportBundles = reports.svcReportBundles
    return { ...f, fetch, reports }
  }
  function runBound(
    messages: ChatMessage[],
    stream: boolean,
    external: boolean,
    extra: Record<string, unknown> = {}
  ) {
    const input = {
      config,
      messages,
      profileId: 'fixture-profile',
      ...(external ? { externalAgentSkill: agent } : {}),
      ...extra
    }
    return stream
      ? requestChatCompletionStream({ ...input, onEvent: vi.fn() })
      : requestChatCompletion(input)
  }
  // [name, messages, service, request extras, whether MAIN is asked at all]
  const refusals: ReadonlyArray<
    readonly [
      string,
      (r: ReturnType<typeof boundFixture>['reports']) => ChatMessage[],
      'registry' | 'missing' | 'rejecting',
      Record<string, unknown>,
      boolean
    ]
  > = [
    [
      'a well-formed binding that verify refuses',
      () => [
        {
          role: 'user',
          content: 'synthetic',
          attachments: [
            primary({
              reportBundleBinding: `rb1.${'B'.repeat(43)}`,
              reportBundleManifestUrl: 'local-media:///synthetic/manifest.json'
            })
          ]
        }
      ],
      'registry',
      { conversationId },
      true
    ],
    [
      'a binding registered for another conversation',
      (r) => [
        {
          role: 'user',
          content: 'synthetic',
          attachments: [
            r.register(
              primary({ reportBundleManifestUrl: 'local-media:///synthetic/manifest.json' }),
              'another-conversation'
            )
          ]
        }
      ],
      'registry',
      { conversationId },
      true
    ],
    [
      'a request without a conversation id',
      (r) => [
        {
          role: 'user',
          content: 'synthetic',
          attachments: [
            r.register(
              primary({ reportBundleManifestUrl: 'local-media:///synthetic/manifest.json' }),
              conversationId
            )
          ]
        }
      ],
      'registry',
      {},
      false
    ],
    [
      'an api without svcReportBundles',
      (r) => [
        {
          role: 'user',
          content: 'synthetic',
          attachments: [
            r.register(
              primary({ reportBundleManifestUrl: 'local-media:///synthetic/manifest.json' }),
              conversationId
            )
          ]
        }
      ],
      'missing',
      { conversationId },
      false
    ],
    [
      'a rejecting verify',
      (r) => [
        {
          role: 'user',
          content: 'synthetic',
          attachments: [
            r.register(
              primary({ reportBundleManifestUrl: 'local-media:///synthetic/manifest.json' }),
              conversationId
            )
          ]
        }
      ],
      'rejecting',
      { conversationId },
      true
    ],
    [
      'a verified binding whose primary also carries media',
      (r) => [
        {
          role: 'user',
          content: 'synthetic',
          attachments: [
            {
              ...r.register(
                primary({ reportBundleManifestUrl: 'local-media:///synthetic/manifest.json' }),
                conversationId
              ),
              media: managedMedia
            }
          ]
        }
      ],
      'registry',
      { conversationId },
      false
    ],
    [
      'a verified binding in history carried by another url',
      (r) => {
        const bound = r.register(
          primary({ reportBundleManifestUrl: 'local-media:///synthetic/manifest.json' }),
          conversationId
        )
        return [
          {
            role: 'assistant',
            content: 'old',
            attachments: [{ ...bound, url: 'data:text/plain;base64,Qg==' }]
          },
          { role: 'user', content: 'synthetic', attachments: [bound] }
        ]
      },
      'registry',
      { conversationId },
      false
    ]
  ]
  for (const [route, stream, external] of routes) {
    it.each(refusals)(
      `refuses %s before any read or dispatch (${route})`,
      async (_name, build, service, extra, asksMain) => {
        const f = boundFixture(service)
        const messages = build(f.reports)
        const before = JSON.stringify(messages)
        const error = await runBound(messages, stream, external, extra).then(
          () => undefined,
          (caught: unknown) => caught
        )
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe(UNVERIFIED_REPORT_BUNDLE_MESSAGE)
        expect(String(error)).not.toContain('rb1.')
        for (const fn of [
          f.fetch,
          f.materialize,
          f.chat,
          f.chatStream,
          f.remoteFetch,
          f.externalAgentStream
        ])
          expect(fn).not.toHaveBeenCalled()
        expect(JSON.stringify(messages)).toBe(before)
        expect(f.reports.verify).toHaveBeenCalledTimes(asksMain ? 1 : 0)
      }
    )
  }

  it('refuses more distinct bound reports than one verify call takes, without calling verify', async () => {
    const f = boundFixture()
    const attachments = Array.from({ length: 65 }, () =>
      f.reports.register(primary(), conversationId)
    )
    await expect(
      runBound([{ role: 'user', content: 'synthetic', attachments }], false, false, {
        conversationId
      })
    ).rejects.toThrow(UNVERIFIED_REPORT_BUNDLE_MESSAGE)
    expect(f.reports.verify).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.chat).not.toHaveBeenCalled()
  })

  it('verifies a report referenced by many messages once, in every role', async () => {
    const f = boundFixture()
    const bound = f.reports.register(primary(), conversationId, { manifestUrl: null })
    await expect(
      runBound(
        [
          { role: 'assistant', content: 'old', attachments: [bound] },
          { role: 'user', content: 'synthetic', attachments: [bound, bound] }
        ],
        false,
        false,
        { conversationId, storageScope: 'project.pane' }
      )
    ).resolves.toBeDefined()
    expect(f.reports.verify).toHaveBeenCalledOnce()
    expect(f.reports.verify.mock.calls[0][0]).toEqual({
      conversation: { conversationId, storageScope: 'project.pane' },
      items: [{ binding: bound.reportBundleBinding, primaryUrl: bound.url }]
    })
    // The report capability probe and the request itself.
    expect(f.chat).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])(
    'sends a verified report to an external agent without its binding (stream=%s)',
    async (stream) => {
      const f = boundFixture()
      const bound = f.reports.register(primary(), conversationId, { manifestUrl: null })
      await expect(
        runBound([{ role: 'user', content: 'synthetic', attachments: [bound] }], stream, true, {
          conversationId
        })
      ).resolves.toBeDefined()
      const transport = stream ? f.externalAgentStream : f.remoteFetch
      expect(transport).toHaveBeenCalledOnce()
      const sent = JSON.stringify((transport.mock.calls[0] as unknown[])[0])
      expect(sent).toContain('report.txt')
      expect(sent).not.toContain(bound.reportBundleBinding)
      expect(sent).not.toContain('reportBundleBinding')
    }
  )

  it('never touches the bridge for a request without primary reports', async () => {
    const f = boundFixture()
    await expect(
      runBound(
        [
          {
            role: 'user',
            content: 'synthetic',
            attachments: [
              {
                type: 'file',
                url: 'data:text/plain;base64,QQ==',
                fileName: 'ordinary.txt',
                mimeType: 'text/plain'
              }
            ]
          }
        ],
        false,
        false
      )
    ).resolves.toBeDefined()
    expect(f.reports.verify).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'reads only the manifest URL MAIN returns, never the descriptor one (stream=%s)',
    async (stream) => {
      const f = boundFixture()
      const forged = 'local-media:///synthetic/forged-manifest.json'
      const owned = 'local-media:///synthetic/main-snapshot/manifest.json'
      f.fetch.mockImplementation(async (url: string | URL | Request) => {
        if (String(url) === owned)
          return new Response(
            JSON.stringify({
              version: 1,
              bundleId: 'owned',
              title: 'Owned',
              entries: [
                {
                  role: 'report-image',
                  fileName: 'fig.png',
                  mimeType: 'image/png',
                  sourceUrl: 'data:image/png;base64,aW1hZ2U='
                }
              ]
            })
          )
        if (String(url) === forged) throw new Error('descriptor manifest was read')
        return new Response('synthetic', { headers: { 'content-type': 'text/plain' } })
      })
      const bound = f.reports.register(
        primary({ reportBundleId: 'owned', reportBundleManifestUrl: forged }),
        conversationId,
        { manifestUrl: owned, imageCount: 1 }
      )
      const messages: ChatMessage[] = [{ role: 'user', content: 'synthetic', attachments: [bound] }]
      const before = JSON.stringify(messages)
      await expect(runBound(messages, stream, false, { conversationId })).resolves.toBeDefined()
      const urls = f.fetch.mock.calls.map(([url]) => String(url))
      expect(urls).toContain(owned)
      expect(urls).not.toContain(forged)
      const ipc = stream ? f.chatStream : f.chat
      // The last call is the request (unary also ran the report capability probe first).
      const sent = (ipc.mock.calls.at(-1) as unknown[])[0] as { messages: ChatMessage[] }
      const attachments = sent.messages.flatMap((message) => message.attachments ?? [])
      expect(
        attachments.find((attachment) => attachment.reportBundleRole === 'primary-report')
      ).toMatchObject({ reportBundleManifestUrl: owned, reportBundleImageCount: 1 })
      expect(attachments.filter((attachment) => attachment.type === 'image')).toHaveLength(1)
      expect(JSON.stringify(messages)).toBe(before)
    }
  )

  it("reads only MAIN's manifest URL for a history bundle under the all-history policy", async () => {
    const f = boundFixture()
    const forged = 'local-media:///synthetic/forged-history-manifest.json'
    const owned = 'local-media:///synthetic/main-history/manifest.json'
    f.fetch.mockImplementation(async (url: string | URL | Request) => {
      if (String(url) === owned)
        return new Response(
          JSON.stringify({ version: 1, bundleId: 'history', title: 'History', entries: [] })
        )
      if (String(url) === forged) throw new Error('descriptor manifest was read')
      return new Response('synthetic', { headers: { 'content-type': 'text/plain' } })
    })
    const bound = f.reports.register(primary({ reportBundleManifestUrl: forged }), conversationId, {
      manifestUrl: owned
    })
    await expect(
      runBound(
        [
          { role: 'user', content: 'old', attachments: [bound] },
          { role: 'user', content: 'new' }
        ],
        false,
        false,
        { conversationId, imageHistoryPolicy: 'all' }
      )
    ).resolves.toBeDefined()
    const urls = f.fetch.mock.calls.map(([url]) => String(url))
    expect(urls.filter((url) => url === owned)).toHaveLength(1)
    expect(urls).not.toContain(forged)
  })

  it("counts MAIN's image count, not a forged low hint, against a finite image limit", async () => {
    const f = boundFixture()
    const limited: Config = {
      ...config,
      llm_config: {
        ...config.llm_config,
        api_profiles: [
          { ...config.llm_config.api_profiles[0], api_mode: 'responses', max_input_images: 10 }
        ]
      }
    }
    const owned = 'local-media:///synthetic/main-count/manifest.json'
    f.fetch.mockImplementation(async (url: string | URL | Request) => {
      if (String(url) === owned) return new Response('unavailable', { status: 404 })
      return new Response('synthetic', { headers: { 'content-type': 'text/plain' } })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const bound = f.reports.register(
        primary({
          reportBundleId: 'counted',
          reportBundleImageCount: 0,
          reportBundleManifestUrl: owned
        }),
        conversationId,
        { imageCount: 11 }
      )
      const messages: ChatMessage[] = [{ role: 'user', content: 'synthetic', attachments: [bound] }]
      await expect(
        runBound(messages, false, false, { conversationId, config: limited })
      ).rejects.toThrow('Too many images; the limit is 10.')
      expect(f.chat).not.toHaveBeenCalled()
      expect(f.materialize).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    ['dom-exception', false],
    ['dom-exception', true],
    ['string', false],
    ['string', true]
  ] as const)(
    'stops with the abort reason while verify is pending (%s, stream=%s)',
    async (reasonType, stream) => {
      const f = boundFixture()
      const cancelConversation = vi.fn()
      ;(window.api.svcLLMProxy as unknown as Record<string, unknown>).cancelConversation =
        cancelConversation
      let resolveVerify!: (value: unknown) => void
      f.reports.verify.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveVerify = resolve as (value: unknown) => void
          })
      )
      const controller = new AbortController()
      const bound = f.reports.register(
        primary({ reportBundleManifestUrl: 'local-media:///synthetic/manifest.json' }),
        conversationId
      )
      const pending = runBound(
        [{ role: 'user', content: 'synthetic', attachments: [bound] }],
        stream,
        false,
        { conversationId, signal: controller.signal }
      ).then(
        () => undefined,
        (caught: unknown) => caught
      )
      await vi.waitFor(() => expect(f.reports.verify).toHaveBeenCalledOnce())
      const reason =
        reasonType === 'string'
          ? 'Chat session cancelled.'
          : new DOMException('cancel verify', 'AbortError')
      controller.abort(reason)
      const error = await pending
      expect(error).toMatchObject({
        name: 'AbortError',
        message: reasonType === 'string' ? reason : 'cancel verify'
      })
      if (reasonType !== 'string') expect(error).toBe(reason)
      resolveVerify({
        results: [
          {
            binding: bound.reportBundleBinding,
            status: 'verified',
            manifestUrl: 'local-media:///synthetic/manifest.json',
            imageCount: 0
          }
        ]
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (const fn of [
        f.fetch,
        f.materialize,
        f.chat,
        f.chatStream,
        f.remoteFetch,
        f.externalAgentStream,
        cancelConversation
      ])
        expect(fn).not.toHaveBeenCalled()
    }
  )
})
