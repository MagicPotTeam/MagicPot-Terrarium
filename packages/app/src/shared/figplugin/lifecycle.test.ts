import { describe, expect, it } from 'vitest'

import {
  FIGPLUGIN_MAX_PAYLOAD_BYTES,
  isFigPluginCallWithinPayloadLimit,
  isFigPluginConfigWithinLimit,
  measureFigPluginConfigBytes,
  isFigPluginRequestWithinTimeout,
  isSameFigPluginIdempotentRequest,
  safeParseFigPluginLifecycleRequest,
  safeParseFigPluginLifecycleResponse,
  type FigPluginCallRequest
} from './index'

const manifest = {
  schemaVersion: 1,
  id: 'demo.figplugin',
  name: 'Demo FIGPLUGIN',
  version: '1.0.0',
  host: 'photoshop',
  capabilities: ['background-removal', 'asset-transfer', 'result-transfer'],
  permissions: {
    dialogue: 'none',
    backgroundRemoval: 'prompt',
    assetTransfer: 'read',
    resultTransfer: 'write',
    filesystem: 'none',
    network: 'none'
  },
  limits: {
    maxPayloadBytes: FIGPLUGIN_MAX_PAYLOAD_BYTES,
    maxResultBytes: FIGPLUGIN_MAX_PAYLOAD_BYTES,
    maxConfigBytes: 16 * 1024,
    maxCallTimeoutMs: 60_000,
    maxConcurrentCalls: 1
  },
  provenance: {
    publisherId: 'magicpot',
    publisherName: 'MagicPot',
    source: 'official',
    artifactSha256: 'a'.repeat(64),
    sourceUrl: 'https://example.com/plugins/demo',
    issuedAt: '2026-01-01T00:00:00.000Z'
  },
  signature: {
    algorithm: 'ed25519',
    keyId: 'magicpot-release',
    value: 'b'.repeat(128),
    signedAt: '2026-01-01T00:00:00.000Z'
  },
  assets: []
} as const

const callRequest = (overrides: Record<string, unknown> = {}): FigPluginCallRequest =>
  ({
    kind: 'call',
    requestId: 'request-1',
    idempotencyKey: 'idem-key-1',
    pluginId: 'demo.figplugin',
    host: 'photoshop',
    capability: 'background-removal',
    payload: {
      operation: 'background-removal',
      input: {
        contentType: 'asset-reference',
        sizeBytes: 1024,
        transfer: {
          transferId: 'transfer-1',
          kind: 'asset',
          fileName: 'input.png',
          relativePath: 'assets/input.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          sha256: 'c'.repeat(64),
          source: 'magicpot'
        }
      },
      output: {
        contentType: 'asset-reference',
        sizeBytes: 2048,
        transfer: {
          transferId: 'transfer-2',
          kind: 'result',
          fileName: 'result.png',
          relativePath: 'results/result.png',
          mimeType: 'image/png',
          sizeBytes: 2048,
          sha256: 'd'.repeat(64),
          source: 'plugin'
        }
      }
    },
    payloadMetadata: {
      contentType: 'asset-reference',
      sizeBytes: 3072,
      transfer: {
        transferId: 'transfer-1',
        kind: 'asset',
        fileName: 'input.png',
        relativePath: 'assets/input.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        sha256: 'c'.repeat(64),
        source: 'magicpot'
      }
    },
    requestedAt: '2026-01-01T00:00:00.000Z',
    timeoutMs: 30_000,
    cancellation: { requested: false },
    ...overrides
  }) as FigPluginCallRequest

describe('FIGPLUGIN lifecycle contract', () => {
  it('validates install and call requests with bounded transfer metadata', () => {
    expect(
      safeParseFigPluginLifecycleRequest({
        kind: 'install',
        requestId: 'install-1',
        idempotencyKey: 'install-key-1',
        manifest,
        requestedAt: '2026-01-01T00:00:00.000Z',
        timeoutMs: 30_000,
        cancellation: { requested: false }
      }).success
    ).toBe(true)
    expect(safeParseFigPluginLifecycleRequest(callRequest()).success).toBe(true)
  })

  it('distinguishes request IDs from idempotent replay keys', () => {
    const first = callRequest()
    const replay = callRequest({ requestId: 'request-2' })
    const conflict = callRequest({ idempotencyKey: 'idem-key-2' })

    expect(isSameFigPluginIdempotentRequest(first, replay)).toBe(true)
    expect(isSameFigPluginIdempotentRequest(first, conflict)).toBe(false)
    expect(first.requestId).not.toBe(replay.requestId)
  })

  it('uses an install manifest id for idempotency identity without executing it', () => {
    const first = {
      kind: 'install' as const,
      idempotencyKey: 'install-key-1',
      manifest: { id: 'demo.figplugin' }
    }
    const replay = { ...first }
    const conflict = { ...first, manifest: { id: 'other.figplugin' } }

    expect(isSameFigPluginIdempotentRequest(first, replay)).toBe(true)
    expect(isSameFigPluginIdempotentRequest(first, conflict)).toBe(false)
  })

  it.each([
    ['empty request id', { requestId: ' ' }],
    ['empty idempotency key', { idempotencyKey: ' ' }],
    [
      'invalid path',
      {
        payload: {
          operation: 'background-removal',
          input: {
            contentType: 'asset-reference',
            sizeBytes: 1,
            transfer: {
              transferId: 'transfer-1',
              kind: 'asset',
              fileName: 'input.png',
              relativePath: '../outside.png',
              mimeType: 'image/png',
              sizeBytes: 1,
              sha256: 'c'.repeat(64),
              source: 'magicpot'
            }
          }
        }
      }
    ],
    [
      'oversized payload metadata',
      {
        payloadMetadata: {
          contentType: 'binary',
          sizeBytes: FIGPLUGIN_MAX_PAYLOAD_BYTES + 1,
          mimeType: 'image/png'
        }
      }
    ],
    ['invalid timeout', { timeoutMs: 0 }],
    ['missing cancellation timestamp', { cancellation: { requested: true } }],
    ['unknown field', { unexpected: true }]
  ])('rejects %s', (_label, override) => {
    expect(safeParseFigPluginLifecycleRequest(callRequest(override)).success).toBe(false)
  })

  it('enforces payload, result, config, and timeout limits', () => {
    const validManifest = {
      limits: {
        maxPayloadBytes: 4096,
        maxResultBytes: 2048,
        maxConfigBytes: 1024,
        maxCallTimeoutMs: 5000,
        maxConcurrentCalls: 1
      }
    }
    const boundedRequest = callRequest({
      payload: {
        ...callRequest().payload,
        input: { ...callRequest().payload.input, sizeBytes: 1024 },
        output: { ...callRequest().payload.output, sizeBytes: 1024 }
      },
      payloadMetadata: { ...callRequest().payloadMetadata, sizeBytes: 2048 }
    })

    expect(
      isFigPluginCallWithinPayloadLimit(boundedRequest, {
        limits: {
          ...validManifest.limits,
          maxPayloadBytes: 4096,
          maxResultBytes: 2048
        }
      })
    ).toBe(true)
    expect(
      isFigPluginCallWithinPayloadLimit(
        callRequest({
          payloadMetadata: { ...callRequest().payloadMetadata, sizeBytes: 4097 }
        }),
        validManifest
      )
    ).toBe(false)
    expect(
      isFigPluginCallWithinPayloadLimit(
        callRequest({
          payload: {
            ...callRequest().payload,
            output: { ...callRequest().payload.output, sizeBytes: 2049 }
          }
        }),
        validManifest
      )
    ).toBe(false)
    const config = { quality: 'high' }
    const configBytes = measureFigPluginConfigBytes(config)
    expect(
      isFigPluginConfigWithinLimit(
        { config, configBytes },
        {
          limits: {
            ...validManifest.limits,
            maxConfigBytes: Math.max(configBytes, 1024)
          }
        }
      )
    ).toBe(true)
    expect(isFigPluginConfigWithinLimit({ config, configBytes: 0 }, validManifest)).toBe(false)
    expect(
      isFigPluginConfigWithinLimit(
        { config: { value: 'x'.repeat(70_000) }, configBytes: 0 },
        validManifest
      )
    ).toBe(false)
    expect(isFigPluginRequestWithinTimeout({ timeoutMs: 5000 }, validManifest)).toBe(true)
    expect(isFigPluginRequestWithinTimeout({ timeoutMs: 5001 }, validManifest)).toBe(false)
  })

  it('requires exact input transfer correlation and consistent byte accounting', () => {
    const valid = callRequest()
    expect(safeParseFigPluginLifecycleRequest(valid).success).toBe(true)
    expect(
      safeParseFigPluginLifecycleRequest({
        ...valid,
        payloadMetadata: {
          ...valid.payloadMetadata,
          transfer: { ...valid.payloadMetadata.transfer, fileName: 'other.png' }
        }
      }).success
    ).toBe(false)
    expect(
      safeParseFigPluginLifecycleRequest({
        ...valid,
        payload: {
          ...valid.payload,
          input: {
            ...valid.payload.input,
            transfer: { ...valid.payload.input.transfer, sha256: 'e'.repeat(64) }
          }
        }
      }).success
    ).toBe(false)
    expect(
      safeParseFigPluginLifecycleRequest({
        ...valid,
        payloadMetadata: { ...valid.payloadMetadata, sizeBytes: 2048 }
      }).success
    ).toBe(false)
  })

  it('returns false for an idempotency key reused with changed request semantics', () => {
    const first = callRequest()
    expect(isSameFigPluginIdempotentRequest(first, { ...first, requestId: 'request-2' })).toBe(true)
    expect(
      isSameFigPluginIdempotentRequest(first, {
        ...first,
        host: 'figma'
      } as FigPluginCallRequest)
    ).toBe(false)
    expect(
      isSameFigPluginIdempotentRequest(first, {
        ...first,
        payload: { ...first.payload, dialogueText: undefined }
      } as FigPluginCallRequest)
    ).toBe(false)
  })

  it('validates typed failure reasons and response branch invariants', () => {
    const response = {
      ok: false,
      requestId: 'request-1',
      idempotencyKey: 'idem-key-1',
      pluginId: 'demo.figplugin',
      host: 'photoshop',
      state: 'failed',
      completedAt: '2026-01-01T00:00:00.000Z',
      failure: {
        reason: 'permission-denied',
        message: 'Permission required',
        retryable: false,
        requestId: 'request-1'
      }
    }

    expect(safeParseFigPluginLifecycleResponse(response).success).toBe(true)
    expect(
      safeParseFigPluginLifecycleResponse({
        ...response,
        failure: { ...response.failure, reason: 'nope' }
      }).success
    ).toBe(false)
    expect(safeParseFigPluginLifecycleResponse({ ...response, ok: true }).success).toBe(false)
    expect(
      safeParseFigPluginLifecycleResponse({
        ...response,
        ok: true,
        state: 'failed',
        failure: undefined
      }).success
    ).toBe(false)
    expect(
      safeParseFigPluginLifecycleResponse({
        ...response,
        ok: false,
        state: 'ready'
      }).success
    ).toBe(false)
    expect(
      safeParseFigPluginLifecycleResponse({
        ...response,
        manifest,
        failure: undefined
      }).success
    ).toBe(false)
  })
})
