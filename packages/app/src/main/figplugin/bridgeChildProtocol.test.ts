import { describe, expect, it } from 'vitest'
import {
  decodeFigPluginBridgeChildFrame,
  encodeFigPluginBridgeChildFrame,
  FIGPLUGIN_BRIDGE_CHILD_FRAME,
  FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES,
  frameForBootstrap
} from './bridgeChildProtocol'

const input = {
  protocol: 1 as const,
  nonce: 'a'.repeat(32),
  origin: 'http://127.0.0.1:41234'
}

describe('bridge child framed protocol', () => {
  it('round-trips a canonical bootstrap frame', () => {
    const frame = frameForBootstrap(input)
    expect(decodeFigPluginBridgeChildFrame(frame)).toEqual({
      frame: FIGPLUGIN_BRIDGE_CHILD_FRAME,
      kind: 'bootstrap',
      ...input
    })
  })

  it('rejects non-string, malformed, wrong-marker and extra-field values', () => {
    expect(decodeFigPluginBridgeChildFrame({ kind: 'bootstrap', ...input })).toBeUndefined()
    expect(decodeFigPluginBridgeChildFrame('{')).toBeUndefined()
    expect(
      decodeFigPluginBridgeChildFrame(
        JSON.stringify({ frame: 'other/v1', kind: 'bootstrap', ...input })
      )
    ).toBeUndefined()
    expect(
      decodeFigPluginBridgeChildFrame(
        JSON.stringify({
          frame: FIGPLUGIN_BRIDGE_CHILD_FRAME,
          kind: 'bootstrap',
          ...input,
          secret: 'x'
        })
      )
    ).toBeUndefined()
    const canonical = frameForBootstrap(input)
    expect(decodeFigPluginBridgeChildFrame(` ${canonical}`)).toBeUndefined()
    const parsed = JSON.parse(canonical) as Record<string, unknown>
    const reordered = JSON.stringify({
      kind: parsed.kind,
      frame: parsed.frame,
      protocol: parsed.protocol,
      nonce: parsed.nonce,
      origin: parsed.origin
    })
    expect(reordered).not.toBe(canonical)
    expect(decodeFigPluginBridgeChildFrame(reordered)).toBeUndefined()
  })

  it('bounds encoded and decoded UTF-8 frame bytes', () => {
    expect(() =>
      encodeFigPluginBridgeChildFrame({
        kind: 'bootstrap',
        protocol: 1,
        nonce: 'a'.repeat(32),
        origin: `http://127.0.0.1:${'1'.repeat(5000)}`
      })
    ).toThrow()
    expect(
      decodeFigPluginBridgeChildFrame('x'.repeat(FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES + 1))
    ).toBeUndefined()
  })
})
