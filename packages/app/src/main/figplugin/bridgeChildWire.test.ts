import { describe, expect, it } from 'vitest'
import {
  FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES,
  FIGPLUGIN_BRIDGE_CHILD_WIRE_PROTOCOL,
  FigPluginBridgeChildWireError,
  decodeFigPluginBridgeChildRpcCancel,
  decodeFigPluginBridgeChildRpcRequest,
  decodeFigPluginBridgeChildRpcResponse,
  encodeFigPluginBridgeChildRpcCancel,
  encodeFigPluginBridgeChildRpcRequest,
  encodeFigPluginBridgeChildRpcResponse
} from './bridgeChildWire'

const nonce = 'a'.repeat(32)
const requestId = 'b'.repeat(32)
const session = 'c'.repeat(32)
const token = 'd'.repeat(64)
const correlationId = 'e'.repeat(32)

const errorCode = (code: string) => expect.objectContaining({ code })

describe('strict Bridge child RPC wire', () => {
  it('round-trips a canonical request and preserves the method allowlist envelope', () => {
    const frame = encodeFigPluginBridgeChildRpcRequest({
      nonce,
      requestId,
      correlationId,
      method: 'prepare',
      session,
      token,
      body: {
        protocol: 1,
        sequence: 1,
        requestId: 'client-request',
        prompt: 'read',
        context: { nodes: [] }
      }
    })
    const parsed = decodeFigPluginBridgeChildRpcRequest(frame, nonce)
    expect(parsed).toMatchObject({
      kind: 'request',
      protocol: FIGPLUGIN_BRIDGE_CHILD_WIRE_PROTOCOL,
      nonce,
      requestId,
      method: 'prepare',
      session,
      token,
      correlationId
    })
    expect(parsed.body).toEqual({
      protocol: 1,
      sequence: 1,
      requestId: 'client-request',
      prompt: 'read',
      context: { nodes: [] }
    })
  })

  it('allows redeem without a session and requires session/token for every other method', () => {
    expect(() =>
      encodeFigPluginBridgeChildRpcRequest({
        nonce,
        requestId,
        method: 'redeem',
        body: { protocol: 1 }
      })
    ).not.toThrow()
    expect(() =>
      encodeFigPluginBridgeChildRpcRequest({
        nonce,
        requestId,
        method: 'status',
        body: { callId: requestId }
      })
    ).toThrow(errorCode('INVALID'))
    expect(() =>
      encodeFigPluginBridgeChildRpcRequest({
        nonce,
        requestId,
        method: 'redeem',
        session,
        token,
        body: { protocol: 1 }
      })
    ).toThrow(errorCode('INVALID'))
  })

  it('rejects unknown methods, unknown fields, malformed IDs and nonce mismatches', () => {
    const valid = encodeFigPluginBridgeChildRpcRequest({
      nonce,
      requestId,
      correlationId,
      method: 'status',
      session,
      token,
      body: { callId: requestId }
    })
    const object = JSON.parse(valid) as Record<string, unknown>
    object.method = 'approve'
    expect(() => decodeFigPluginBridgeChildRpcRequest(JSON.stringify(object), nonce)).toThrow(
      errorCode('INVALID')
    )
    object.method = 'status'
    object.extra = true
    expect(() => decodeFigPluginBridgeChildRpcRequest(JSON.stringify(object), nonce)).toThrow(
      errorCode('INVALID')
    )
    delete object.extra
    object.requestId = 'not-an-id'
    expect(() => decodeFigPluginBridgeChildRpcRequest(JSON.stringify(object), nonce)).toThrow(
      errorCode('INVALID')
    )
    object.requestId = requestId
    object.correlationId = 'bad'
    expect(() => decodeFigPluginBridgeChildRpcRequest(JSON.stringify(object), nonce)).toThrow(
      errorCode('INVALID')
    )
    object.correlationId = correlationId
    expect(() => decodeFigPluginBridgeChildRpcRequest(valid, 'e'.repeat(32))).toThrow(
      errorCode('NONCE_MISMATCH')
    )
    expect(() => decodeFigPluginBridgeChildRpcRequest(valid, 'bad')).toThrow(errorCode('INVALID'))
  })

  it('rejects noncanonical frames and all over-budget frames before dispatch', () => {
    const valid = encodeFigPluginBridgeChildRpcRequest({
      nonce,
      requestId,
      method: 'status',
      session,
      token,
      body: { callId: requestId }
    })
    const parsed = JSON.parse(valid) as Record<string, unknown>
    const noncanonical = JSON.stringify({
      body: parsed.body,
      method: parsed.method,
      requestId: parsed.requestId,
      nonce: parsed.nonce,
      protocol: parsed.protocol,
      token: parsed.token,
      session: parsed.session,
      kind: parsed.kind
    })
    // JSON.stringify above keeps insertion order from the parsed object, while
    // the wire requires the canonical sorted form emitted by encode().
    expect(() => decodeFigPluginBridgeChildRpcRequest(noncanonical, nonce)).toThrow(
      errorCode('INVALID')
    )
    const oversized = `${' '.repeat(FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES)}x`
    expect(() => decodeFigPluginBridgeChildRpcRequest(oversized, nonce)).toThrow(errorCode('LIMIT'))
  })

  it('rejects accessors, proxies, cycles and non-JSON numeric values before stringify', () => {
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => 'must not run'
    })
    expect(() =>
      encodeFigPluginBridgeChildRpcRequest({
        nonce,
        requestId,
        method: 'redeem',
        body: accessor
      })
    ).toThrow(errorCode('INVALID'))
    const envelope = Object.defineProperty({ nonce, requestId, method: 'redeem' }, 'body', {
      enumerable: true,
      get: () => 'must not run'
    })
    expect(() => encodeFigPluginBridgeChildRpcRequest(envelope as never)).toThrow(
      errorCode('INVALID')
    )
    expect(() => encodeFigPluginBridgeChildRpcRequest(null as never)).toThrow(errorCode('INVALID'))
    const proxy = new Proxy({ value: 1 }, {})
    expect(() =>
      encodeFigPluginBridgeChildRpcRequest({ nonce, requestId, method: 'redeem', body: proxy })
    ).toThrow(errorCode('INVALID'))
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() =>
      encodeFigPluginBridgeChildRpcRequest({ nonce, requestId, method: 'redeem', body: cycle })
    ).toThrow(errorCode('INVALID'))
    expect(() =>
      encodeFigPluginBridgeChildRpcRequest({ nonce, requestId, method: 'redeem', body: NaN })
    ).toThrow(errorCode('INVALID'))
    const sparse: unknown[] = []
    sparse.length = 2
    expect(() =>
      encodeFigPluginBridgeChildRpcRequest({ nonce, requestId, method: 'redeem', body: sparse })
    ).toThrow(errorCode('INVALID'))
    const symbolKey = [] as unknown as unknown[] & { [key: symbol]: unknown }
    symbolKey[Symbol('hidden')] = true
    expect(() =>
      encodeFigPluginBridgeChildRpcRequest({ nonce, requestId, method: 'redeem', body: symbolKey })
    ).toThrow(errorCode('INVALID'))
  })

  it('round-trips success, void and sanitized error responses', () => {
    const success = encodeFigPluginBridgeChildRpcResponse({
      nonce,
      requestId,
      result: { status: 'ok' }
    })
    expect(decodeFigPluginBridgeChildRpcResponse(success, nonce)).toMatchObject({
      ok: true,
      result: { status: 'ok' }
    })
    const voidResponse = encodeFigPluginBridgeChildRpcResponse({
      nonce,
      requestId,
      result: undefined
    })
    expect(decodeFigPluginBridgeChildRpcResponse(voidResponse, nonce)).toMatchObject({
      ok: true,
      result: null
    })
    const failure = encodeFigPluginBridgeChildRpcResponse({
      nonce,
      requestId,
      correlationId,
      errorCode: 'CONFIGURATION_CHANGED'
    })
    expect(decodeFigPluginBridgeChildRpcResponse(failure, nonce)).toMatchObject({
      ok: false,
      correlationId,
      errorCode: 'CONFIGURATION_CHANGED'
    })
    expect(() =>
      encodeFigPluginBridgeChildRpcResponse({
        nonce,
        requestId,
        result: { ignored: true },
        errorCode: 'CANCELLED'
      } as never)
    ).toThrow(errorCode('INVALID'))
  })

  it('rejects response field confusion, unknown error codes and malformed cancellation', () => {
    const response = JSON.parse(
      encodeFigPluginBridgeChildRpcResponse({ nonce, requestId, result: { ok: true } })
    ) as Record<string, unknown>
    response.errorCode = 'SECRET'
    expect(() => decodeFigPluginBridgeChildRpcResponse(JSON.stringify(response), nonce)).toThrow(
      errorCode('INVALID')
    )
    delete response.errorCode
    response.ok = false
    response.errorCode = 'SECRET'
    delete response.result
    expect(() => decodeFigPluginBridgeChildRpcResponse(JSON.stringify(response), nonce)).toThrow(
      errorCode('INVALID')
    )
    const cancel = encodeFigPluginBridgeChildRpcCancel({ nonce, requestId, correlationId })
    expect(decodeFigPluginBridgeChildRpcCancel(cancel, nonce)).toMatchObject({
      kind: 'cancel',
      requestId,
      correlationId
    })
    const malformed = JSON.parse(cancel) as Record<string, unknown>
    malformed.requestId = 'bad'
    expect(() => decodeFigPluginBridgeChildRpcCancel(JSON.stringify(malformed), nonce)).toThrow(
      errorCode('INVALID')
    )
  })

  it('uses a non-sensitive wire error surface', () => {
    try {
      decodeFigPluginBridgeChildRpcRequest('{"kind":"request"}', nonce)
    } catch (error) {
      expect(error).toBeInstanceOf(FigPluginBridgeChildWireError)
      expect(String(error)).not.toContain('kind')
      expect(String(error)).not.toContain('nonce')
    }
  })
})
