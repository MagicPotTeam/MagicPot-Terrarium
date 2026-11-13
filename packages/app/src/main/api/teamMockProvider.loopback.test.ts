import { afterEach, expect, it } from 'vitest'
import { OpenAIAPICli } from '../../shared/llm/clients'
import {
  FIXTURE_PNG,
  startTeamMockProvider
} from '../../../../../scripts/chat/teamMockProvider.mjs'

let fixture: Awaited<ReturnType<typeof startTeamMockProvider>> | undefined
afterEach(async () => {
  if (fixture) await fixture.close()
  fixture = undefined
})

it('serves a bounded loopback chat-completions fixture to the real client', async () => {
  fixture = await startTeamMockProvider()
  const endpoint = fixture.url
  const localFetch: typeof fetch = (input, init) => {
    if (
      String(input) !== endpoint &&
      String(input) !== endpoint.replace('/chat/completions', '/images/generations')
    )
      throw new Error('fixture forbids all other network destinations')
    return fetch(input, init)
  }
  const cli = new OpenAIAPICli('fixture-only', endpoint, 'fixture-model', {
    apiMode: 'chat-completions',
    fetchImpl: localFetch,
    enableHostedTools: false,
    enableHostedWebSearch: false
  })
  const designer = await cli.chat({
    messages: [{ role: 'user', content: '设计海报' }],
    retryCapacity: false
  })
  expect(designer.content).toBe('设计结果')
  expect(designer.attachments).toEqual([
    expect.objectContaining({ type: 'image', url: FIXTURE_PNG })
  ])
  const textTool = await cli.chat({
    messages: [{ role: 'user', content: '保存工作笔记' }],
    retryCapacity: false
  })
  expect(JSON.parse(textTool.content)).toEqual({
    toolName: 'scratchpad',
    args: { action: 'set', key: 'fixture', value: 'approved-value', expectedRevision: 0 }
  })
  const textContinuation = await cli.chat({
    messages: [
      { role: 'user', content: '保存工作笔记' },
      { role: 'assistant', content: textTool.content },
      { role: 'user', content: 'conversation_scratchpad current-state-not-replay-authority' }
    ],
    retryCapacity: false
  })
  expect(textContinuation.content).toBe('文案结果')
  const tools = [
    { name: 'other', description: 'other tool', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'scratchpad',
      description: 'fixture notes',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string' },
          expectedRevision: { type: 'integer' }
        }
      }
    }
  ]
  const writer = await cli.chat({
    messages: [{ role: 'user', content: '保存工作笔记' }],
    tools,
    retryCapacity: false
  })
  expect(writer.toolCalls).toEqual([
    {
      id: 'fixture-scratchpad',
      name: 'scratchpad',
      wireName: 'mp_tool_1',
      arguments: '{"action":"set","key":"fixture","value":"approved-value","expectedRevision":0}'
    }
  ])
  const continuation = await cli.chat({
    messages: [{ role: 'user', content: '保存工作笔记' }],
    tools,
    toolTurns: [
      {
        content: '',
        calls: writer.toolCalls!,
        results: [{ callId: 'fixture-scratchpad', output: 'fixture-approved' }]
      }
    ],
    retryCapacity: false
  })
  expect(continuation.content).toBe('文案结果')
  const streamedDesigner = await cli.chat({
    messages: [{ role: 'user', content: '设计海报' }],
    onDelta: () => {},
    retryCapacity: false,
    imageGenerationOptions: { enabled: false }
  })
  expect(streamedDesigner.attachments).toEqual([
    expect.objectContaining({ type: 'image', url: FIXTURE_PNG })
  ])
  const streamedWriter = await cli.chat({
    messages: [{ role: 'user', content: '保存工作笔记' }],
    tools,
    onDelta: () => {},
    retryCapacity: false,
    imageGenerationOptions: { enabled: false }
  })
  expect(streamedWriter.toolCalls).toEqual(writer.toolCalls)
  const streamedContinuation = await cli.chat({
    messages: [{ role: 'user', content: '保存工作笔记' }],
    tools,
    toolTurns: [
      {
        content: '',
        calls: streamedWriter.toolCalls!,
        results: [{ callId: 'fixture-scratchpad', output: 'fixture-approved' }]
      }
    ],
    onDelta: () => {},
    retryCapacity: false,
    imageGenerationOptions: { enabled: false }
  })
  expect(streamedContinuation.content).toBe('文案结果')
  const leadMessages = [
    {
      role: 'user' as const,
      content:
        'Team member results for the lead to use in its answer:\n\ndesigner: 设计结果\n\nwriter: 文案结果\n\n汇总团队结果'
    }
  ]
  const trace = await cli.chat({
    messages: [{ role: 'user', content: '设计海报' }],
    onDelta: () => {},
    retryCapacity: false,
    disableAutomaticImageGeneration: true
  })
  expect(trace.attachments).toEqual([expect.objectContaining({ type: 'image', url: FIXTURE_PNG })])
  const streamedLead = await cli.chat({
    messages: leadMessages,
    onDelta: () => {},
    retryCapacity: false,
    imageGenerationOptions: { enabled: false }
  })
  expect(streamedLead.content).toBe('团队汇总：设计结果和文案结果')
  const lead = await cli.chat({ messages: leadMessages, retryCapacity: false })
  expect(lead.content).toBe('团队汇总：设计结果和文案结果')
  await expect(
    cli.chat({ messages: [{ role: 'user', content: '汇总团队结果' }], retryCapacity: false })
  ).rejects.toThrow()
  await expect(
    cli.chat({
      messages: [{ role: 'user', content: 'designer: 设计结果\n\n汇总团队结果' }],
      retryCapacity: false
    })
  ).rejects.toThrow()
  await expect(
    cli.chat({ messages: [{ role: 'user', content: '汇总团队结果 设计结果 文案结果' }], retryCapacity: false })
  ).rejects.toThrow()
  expect(fixture.observed.summaries).toHaveLength(2)
  expect(fixture.observed.summaries[0].userText).toContain('designer: 设计结果')
  expect(fixture.observed.summaries[0].userText).toContain('writer: 文案结果')
  const imageCli = new OpenAIAPICli(
    'fixture-only',
    endpoint.replace('/chat/completions', ''),
    'fixture-image',
    { apiMode: 'images', modelUse: 'image', fetchImpl: localFetch, enableHostedTools: false }
  )
  const generated = await imageCli.chat({
    messages: [{ role: 'user', content: '设计海报' }],
    onDelta: () => {},
    retryCapacity: false
  })
  expect(generated.attachments).toEqual([
    expect.objectContaining({ type: 'image', url: FIXTURE_PNG })
  ])
  expect((await fetch(endpoint, { method: 'GET' })).status).toBe(404)
  expect((await fetch(endpoint, { method: 'POST', body: 'x'.repeat(128 * 1024 + 1) })).status).toBe(
    413
  )
  expect((await fetch(endpoint, { method: 'POST', body: '{' })).status).toBe(400)
})

it('passes an overridden synthetic image data URL through the fixture', async () => {
  // Input is a bounded data URL supplied by this fixture's caller; production
  // screenshot harness supplies a real, visibly-sized PNG.
  const image = 'data:image/png;base64,RklYVFVSRQ=='
  fixture = await startTeamMockProvider({ image })
  const response = await fetch(fixture.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '设计海报' }] })
  })
  const body = await response.json() as { choices: { message: { images: { image_url: { url: string } }[] } }[] }
  expect(image).not.toBe(FIXTURE_PNG)
  expect(body.choices[0].message.images[0].image_url.url).toBe(image)
})
