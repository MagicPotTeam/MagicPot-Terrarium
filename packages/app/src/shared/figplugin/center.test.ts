import { describe, expect, it } from 'vitest'

import {
  FIGPLUGIN_BRIDGE_MANIFEST_VERSION,
  FIGPLUGIN_MAX_PAYLOAD_BYTES,
  canonicalFigPluginRequest,
  measureFigPluginConfigBytes,
  type FigPluginManifestInput
} from './manifest'
import {
  FIGPLUGIN_CENTER_SCHEMA_VERSION,
  getFigPluginCenterIdempotencyFingerprint,
  getFigPluginCenterRequiredConsentPermissions,
  isFigPluginCenterPathCopyDisplayOnly,
  isSameFigPluginCenterIdempotentOperation,
  safeParseFigPluginCenterOperation,
  safeParseFigPluginCenterResponse,
  type FigPluginCenterCallOperation,
  type FigPluginCenterOperation
} from './center'

const manifest = (overrides: Record<string, unknown> = {}): FigPluginManifestInput => ({
  schemaVersion: 1,
  id: 'demo.figplugin',
  name: 'Demo FIGPLUGIN',
  version: '1.2.3',
  host: 'figma',
  entryPath: 'plugin/main.js',
  capabilities: ['dialogue', 'asset-transfer', 'result-transfer'],
  permissions: {
    dialogue: 'prompt',
    backgroundRemoval: 'none',
    assetTransfer: 'read',
    resultTransfer: 'write',
    filesystem: 'none',
    network: 'none'
  },
  limits: {
    maxPayloadBytes: 4096,
    maxResultBytes: 2048,
    maxConfigBytes: 1024,
    maxCallTimeoutMs: 5000,
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
  assets: [],
  ...overrides
})

const bridgeManifest = (): FigPluginManifestInput =>
  manifest({
    schemaVersion: FIGPLUGIN_BRIDGE_MANIFEST_VERSION,
    entryPath: 'plugin/manifest.json',
    capabilities: ['dialogue', 'asset-transfer'],
    permissions: { dialogue: 'prompt', assetTransfer: 'read', network: 'desktop-bridge' },
    bridge: { protocol: 1, origin: 'http://127.0.0.1:43123' }
  })

const base = (kind: FigPluginCenterOperation['kind'], overrides: Record<string, unknown> = {}) => ({
  schemaVersion: FIGPLUGIN_CENTER_SCHEMA_VERSION,
  kind,
  requestId: `${kind}-request`,
  idempotencyKey: `${kind}-idempotency`,
  requestedAt: '2026-01-01T00:00:00.000Z',
  timeoutMs: 1000,
  cancellation: { requested: false },
  ...overrides
})

const consent = (permissions: string[]) => ({
  granted: true,
  permissions,
  grantedAt: '2026-01-01T00:00:00.000Z',
  source: 'user'
})

const callOperation = (overrides: Record<string, unknown> = {}): FigPluginCenterCallOperation =>
  ({
    ...base('call'),
    pluginId: 'demo.figplugin',
    host: 'figma',
    capability: 'dialogue',
    consent: consent(['dialogue']),
    payload: {
      operation: 'dialogue',
      input: { contentType: 'text', sizeBytes: 12 },
      dialogueText: 'Remove the background'
    },
    payloadMetadata: { contentType: 'text', sizeBytes: 12 },
    ...overrides
  }) as FigPluginCenterCallOperation

describe('FIGPLUGIN center contract', () => {
  it('accepts each versioned center operation without executing anything', () => {
    const operations = [
      base('install', { manifest: manifest(), consent: consent(['install']) }),
      base('inspect', { manifest: manifest() }),
      base('configure', {
        pluginId: 'demo.figplugin',
        host: 'figma',
        consent: consent(['configure']),
        config: { quality: 'high' },
        configBytes: measureFigPluginConfigBytes({ quality: 'high' })
      }),
      base('copy-path', {
        pluginId: 'demo.figplugin',
        host: 'figma',
        path: 'plugin/main.js',
        displayOnly: true
      }),
      base('status', { pluginId: 'demo.figplugin', host: 'figma' }),
      callOperation(),
      base('uninstall', {
        pluginId: 'demo.figplugin',
        host: 'figma',
        consent: consent(['uninstall'])
      })
    ]

    for (const operation of operations) {
      expect(safeParseFigPluginCenterOperation(operation).success).toBe(true)
    }
  })

  it('preserves the v1 install JSON and idempotency fingerprint', () => {
    const input = base('install', { manifest: manifest(), consent: consent(['install']) })
    const parsed = safeParseFigPluginCenterOperation(input)
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw new Error('invalid v1 install fixture')
    expect(parsed.data).toStrictEqual(input)
    expect(JSON.stringify(parsed.data)).toBe(
      JSON.stringify({
        schemaVersion: 1,
        requestId: 'install-request',
        idempotencyKey: 'install-idempotency',
        requestedAt: '2026-01-01T00:00:00.000Z',
        timeoutMs: 1000,
        cancellation: { requested: false },
        kind: 'install',
        manifest: manifest(),
        consent: consent(['install'])
      })
    )
    expect(getFigPluginCenterIdempotencyFingerprint(parsed.data)).toBe(
      canonicalFigPluginRequest(input)
    )
  })

  it('accepts explicit v2 manifests inside v1 install/inspect envelopes only', () => {
    expect(FIGPLUGIN_CENTER_SCHEMA_VERSION).toBe(1)
    for (const operation of [
      base('install', { manifest: bridgeManifest(), consent: consent(['install']) }),
      base('inspect', { manifest: bridgeManifest() })
    ]) {
      expect(safeParseFigPluginCenterOperation(operation).success).toBe(true)
      expect(safeParseFigPluginCenterOperation({ ...operation, schemaVersion: 2 }).success).toBe(
        false
      )
      expect(
        safeParseFigPluginCenterOperation({
          ...operation,
          manifest: {
            ...bridgeManifest(),
            permissions: { dialogue: 'prompt', assetTransfer: 'read', network: 'none' }
          }
        }).success
      ).toBe(false)
    }
  })

  it.each(['install', 'status'] as const)(
    'accepts v2 redacted identity in a v1 %s response without making a stored plugin ready',
    (kind) => {
      const input = bridgeManifest()
      const manifestIdentity = {
        schemaVersion: input.schemaVersion,
        id: input.id,
        version: input.version,
        host: input.host,
        capabilities: input.capabilities
      }
      const response = {
        schemaVersion: FIGPLUGIN_CENTER_SCHEMA_VERSION,
        requestId: `${kind}-response`,
        idempotencyKey: `${kind}-idempotency`,
        completedAt: '2026-01-01T00:00:00.000Z',
        kind,
        ok: true,
        pluginId: input.id,
        ...(kind === 'install' ? { manifestIdentity } : {}),
        status: {
          redacted: true,
          pluginId: input.id,
          host: input.host,
          state: 'installed',
          installed: true,
          configured: false,
          ready: false,
          activeCalls: 0,
          manifestIdentity
        }
      }
      const parsed = safeParseFigPluginCenterResponse(response)
      expect(parsed.success).toBe(true)
      if (!parsed.success) throw new Error('invalid v2 redacted response fixture')
      expect(parsed.data).toStrictEqual(response)
      expect(JSON.stringify(parsed.data)).not.toContain('127.0.0.1')
      expect(safeParseFigPluginCenterResponse({ ...response, schemaVersion: 2 }).success).toBe(
        false
      )
      for (const override of [
        { schemaVersion: 3 },
        { bridge: input.bridge },
        { permissions: input.permissions }
      ]) {
        const invalidIdentity = { ...manifestIdentity, ...override }
        expect(
          safeParseFigPluginCenterResponse({
            ...response,
            status: { ...response.status, manifestIdentity: invalidIdentity }
          }).success
        ).toBe(false)
        if (kind === 'install') {
          expect(
            safeParseFigPluginCenterResponse({ ...response, manifestIdentity: invalidIdentity })
              .success
          ).toBe(false)
        }
      }
      expect(
        safeParseFigPluginCenterResponse({
          ...response,
          status: { ...response.status, ready: true }
        }).success
      ).toBe(false)
    }
  )

  it('treats a changed signed bridge origin as an install idempotency conflict', () => {
    const installed = safeParseFigPluginCenterOperation(
      base('install', { manifest: bridgeManifest(), consent: consent(['install']) })
    )
    expect(installed.success).toBe(true)
    if (!installed.success || installed.data.kind !== 'install')
      throw new Error('invalid v2 install fixture')
    const changed = safeParseFigPluginCenterOperation({
      ...installed.data,
      manifest: {
        ...installed.data.manifest,
        bridge: { protocol: 1, origin: 'http://127.0.0.1:43124' }
      }
    })
    expect(changed.success).toBe(true)
    if (!changed.success) throw new Error('invalid changed v2 fixture')
    expect(isSameFigPluginCenterIdempotentOperation(installed.data, changed.data)).toBe(false)
  })

  it('rejects unknown fields, unsupported capabilities, and traversal paths', () => {
    expect(
      safeParseFigPluginCenterOperation({ ...callOperation(), unexpected: true }).success
    ).toBe(false)
    expect(
      safeParseFigPluginCenterOperation({ ...callOperation(), capability: 'shell' }).success
    ).toBe(false)
    expect(
      safeParseFigPluginCenterOperation({
        ...base('copy-path'),
        pluginId: 'demo.figplugin',
        host: 'figma',
        path: '../outside.js',
        displayOnly: true
      }).success
    ).toBe(false)
    expect(
      safeParseFigPluginCenterOperation({
        ...base('copy-path'),
        pluginId: 'demo.figplugin',
        host: 'figma',
        path: 'C:/outside.js',
        displayOnly: true
      }).success
    ).toBe(false)
  })

  it('binds supplied installed manifest identity to call host and capability', () => {
    const dialogueOnlyManifest = manifest({
      capabilities: ['dialogue'],
      permissions: { dialogue: 'prompt' }
    })
    const valid = callOperation({ installedManifest: dialogueOnlyManifest })
    expect(safeParseFigPluginCenterOperation(valid).success).toBe(true)

    expect(safeParseFigPluginCenterOperation({ ...valid, host: 'photoshop' }).success).toBe(false)
    expect(
      safeParseFigPluginCenterOperation({
        ...valid,
        capability: 'background-removal',
        payload: { ...valid.payload, operation: 'background-removal', dialogueText: undefined }
      }).success
    ).toBe(false)
    expect(
      safeParseFigPluginCenterOperation({
        ...valid,
        installedManifest: { ...dialogueOnlyManifest, id: 'other.figplugin' }
      }).success
    ).toBe(false)
  })

  it('keeps copied paths display-only and prevents execution-shaped fields', () => {
    const operation = {
      ...base('copy-path'),
      pluginId: 'demo.figplugin',
      host: 'figma',
      path: 'plugin/main.js',
      displayOnly: true
    }
    const parsed = safeParseFigPluginCenterOperation(operation)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(isFigPluginCenterPathCopyDisplayOnly(parsed.data)).toBe(true)
    expect(safeParseFigPluginCenterOperation({ ...operation, displayOnly: false }).success).toBe(
      false
    )
    expect(safeParseFigPluginCenterOperation({ ...operation, execute: true }).success).toBe(false)
  })

  it('requires explicit consent and transfer permissions for calls', () => {
    expect(
      safeParseFigPluginCenterOperation({
        ...callOperation(),
        consent: { granted: false, permissions: [], source: 'user' }
      }).success
    ).toBe(false)

    const transferCall = callOperation({
      consent: consent(['dialogue', 'asset-transfer', 'result-transfer']),
      payload: {
        operation: 'dialogue',
        dialogueText: 'Describe the selected image',
        input: {
          contentType: 'asset-reference',
          sizeBytes: 100,
          transfer: {
            transferId: 'asset-transfer-1',
            kind: 'asset',
            fileName: 'input.png',
            relativePath: 'assets/input.png',
            mimeType: 'image/png',
            sizeBytes: 100,
            sha256: 'c'.repeat(64),
            source: 'magicpot'
          }
        },
        output: {
          contentType: 'asset-reference',
          sizeBytes: 200,
          transfer: {
            transferId: 'result-transfer-1',
            kind: 'result',
            fileName: 'result.png',
            relativePath: 'results/result.png',
            mimeType: 'image/png',
            sizeBytes: 200,
            sha256: 'd'.repeat(64),
            source: 'plugin'
          }
        }
      },
      payloadMetadata: {
        contentType: 'asset-reference',
        sizeBytes: 300,
        transfer: {
          transferId: 'asset-transfer-1',
          kind: 'asset',
          fileName: 'input.png',
          relativePath: 'assets/input.png',
          mimeType: 'image/png',
          sizeBytes: 100,
          sha256: 'c'.repeat(64),
          source: 'magicpot'
        }
      },
      installedManifest: manifest()
    })
    expect(safeParseFigPluginCenterOperation(transferCall).success).toBe(true)
    expect(getFigPluginCenterRequiredConsentPermissions(transferCall)).toEqual([
      'dialogue',
      'asset-transfer',
      'result-transfer'
    ])

    expect(
      safeParseFigPluginCenterOperation({ ...transferCall, consent: consent(['dialogue']) }).success
    ).toBe(false)
  })

  it('enforces bounded payloads, status identity, and redacted status', () => {
    const oversized = callOperation({
      payload: {
        ...callOperation().payload,
        input: { contentType: 'text', sizeBytes: FIGPLUGIN_MAX_PAYLOAD_BYTES + 1 }
      },
      payloadMetadata: { contentType: 'text', sizeBytes: FIGPLUGIN_MAX_PAYLOAD_BYTES + 1 }
    })
    expect(safeParseFigPluginCenterOperation(oversized).success).toBe(false)

    const status = {
      schemaVersion: FIGPLUGIN_CENTER_SCHEMA_VERSION,
      requestId: 'status-response',
      idempotencyKey: 'status-idempotency',
      completedAt: '2026-01-01T00:00:00.000Z',
      kind: 'status',
      ok: true,
      pluginId: 'demo.figplugin',
      status: {
        redacted: true,
        pluginId: 'demo.figplugin',
        host: 'figma',
        state: 'ready',
        installed: true,
        configured: true,
        ready: true,
        activeCalls: 0,
        manifestIdentity: {
          schemaVersion: 1,
          id: 'demo.figplugin',
          version: '1.2.3',
          host: 'figma',
          capabilities: ['dialogue', 'asset-transfer', 'result-transfer']
        }
      }
    }
    expect(safeParseFigPluginCenterResponse(status).success).toBe(true)
    expect(
      safeParseFigPluginCenterResponse({
        ...status,
        status: {
          ...status.status,
          manifestIdentity: { ...status.status.manifestIdentity, id: 'other' }
        }
      }).success
    ).toBe(false)
  })

  it('requires exact transfer correlation and rejects mismatched byte accounting', () => {
    const valid = {
      ...callOperation(),
      consent: consent(['dialogue', 'asset-transfer', 'result-transfer']),
      payload: {
        operation: 'dialogue' as const,
        dialogueText: 'Describe the selected image',
        input: {
          contentType: 'asset-reference' as const,
          sizeBytes: 100,
          transfer: {
            transferId: 'asset-transfer-1',
            kind: 'asset' as const,
            fileName: 'input.png',
            relativePath: 'assets/input.png',
            mimeType: 'image/png',
            sizeBytes: 100,
            sha256: 'c'.repeat(64),
            source: 'magicpot' as const
          }
        },
        output: {
          contentType: 'asset-reference' as const,
          sizeBytes: 200,
          transfer: {
            transferId: 'result-transfer-1',
            kind: 'result' as const,
            fileName: 'result.png',
            relativePath: 'results/result.png',
            mimeType: 'image/png',
            sizeBytes: 200,
            sha256: 'd'.repeat(64),
            source: 'plugin' as const
          }
        }
      },
      payloadMetadata: {
        contentType: 'asset-reference' as const,
        sizeBytes: 300,
        transfer: {
          transferId: 'asset-transfer-1',
          kind: 'asset' as const,
          fileName: 'input.png',
          relativePath: 'assets/input.png',
          mimeType: 'image/png',
          sizeBytes: 100,
          sha256: 'c'.repeat(64),
          source: 'magicpot' as const
        }
      },
      installedManifest: manifest()
    }
    expect(safeParseFigPluginCenterOperation(valid).success).toBe(true)
    expect(
      safeParseFigPluginCenterOperation({
        ...valid,
        payloadMetadata: {
          ...valid.payloadMetadata,
          transfer: { ...valid.payloadMetadata.transfer, relativePath: 'assets/other.png' }
        }
      }).success
    ).toBe(false)
    expect(
      safeParseFigPluginCenterOperation({
        ...valid,
        payloadMetadata: { ...valid.payloadMetadata, sizeBytes: 299 }
      }).success
    ).toBe(false)
  })

  it('rejects uninstalled, unready, and failed status contradictions', () => {
    const status = {
      redacted: true as const,
      pluginId: 'demo.figplugin',
      host: 'figma' as const,
      state: 'ready' as const,
      installed: true,
      configured: true,
      ready: true,
      activeCalls: 0,
      manifestIdentity: {
        schemaVersion: 1 as const,
        id: 'demo.figplugin',
        version: '1.2.3',
        host: 'figma' as const,
        capabilities: ['dialogue', 'asset-transfer', 'result-transfer'] as const
      }
    }
    const baseStatusResponse = {
      schemaVersion: FIGPLUGIN_CENTER_SCHEMA_VERSION,
      requestId: 'status-response',
      idempotencyKey: 'status-idempotency',
      completedAt: '2026-01-01T00:00:00.000Z',
      kind: 'status' as const,
      ok: true as const,
      pluginId: 'demo.figplugin',
      status
    }
    expect(
      safeParseFigPluginCenterResponse({
        ...baseStatusResponse,
        status: { ...status, installed: false }
      }).success
    ).toBe(false)
    expect(
      safeParseFigPluginCenterResponse({
        ...baseStatusResponse,
        status: { ...status, ready: false }
      }).success
    ).toBe(false)

    const failure = {
      schemaVersion: FIGPLUGIN_CENTER_SCHEMA_VERSION,
      requestId: 'failure-response',
      idempotencyKey: 'failure-idempotency',
      completedAt: '2026-01-01T00:00:00.000Z',
      kind: 'status' as const,
      ok: false as const,
      failure: {
        type: 'figplugin-center-failure' as const,
        reason: 'host-error' as const,
        message: 'host failed',
        retryable: true,
        requestId: 'failure-response',
        idempotencyKey: 'failure-idempotency'
      }
    }
    expect(safeParseFigPluginCenterResponse(failure).success).toBe(true)
  })

  it('treats nested config timestamps and manifest signing dates as request semantics', () => {
    const config = { nested: { requestedAt: 'one', signedAt: 'date-one' } }
    const first = safeParseFigPluginCenterOperation(
      base('configure', {
        pluginId: 'demo.figplugin',
        host: 'figma',
        consent: consent(['configure']),
        config,
        configBytes: measureFigPluginConfigBytes(config)
      })
    )
    expect(first.success).toBe(true)
    if (!first.success) throw new Error('invalid configure fixture')
    const changed = safeParseFigPluginCenterOperation({
      ...first.data,
      config: { nested: { requestedAt: 'two', signedAt: 'date-two' } }
    })
    expect(changed.success).toBe(true)
    if (!changed.success) throw new Error('invalid configure fixture')
    expect(isSameFigPluginCenterIdempotentOperation(first.data, changed.data)).toBe(false)
    const installed = safeParseFigPluginCenterOperation(
      base('install', {
        manifest: manifest(),
        consent: consent(['install'])
      })
    )
    expect(installed.success).toBe(true)
    if (!installed.success || installed.data.kind !== 'install')
      throw new Error('invalid install fixture')
    const renewed = safeParseFigPluginCenterOperation({
      ...installed.data,
      manifest: {
        ...installed.data.manifest,
        signature: {
          ...installed.data.manifest.signature,
          signedAt: '2026-01-02T00:00:00.000Z'
        }
      }
    })
    expect(renewed.success).toBe(true)
    if (!renewed.success) throw new Error('invalid renewed fixture')
    expect(isSameFigPluginCenterIdempotentOperation(installed.data, renewed.data)).toBe(false)
  })

  it('returns false for same idempotency key with changed host or payload', () => {
    const first = callOperation()
    expect(
      isSameFigPluginCenterIdempotentOperation(first, {
        ...first,
        requestId: 'call-request-replay'
      })
    ).toBe(true)
    expect(
      isSameFigPluginCenterIdempotentOperation(first, {
        ...first,
        host: 'photoshop'
      })
    ).toBe(false)
    expect(
      isSameFigPluginCenterIdempotentOperation(first, {
        ...first,
        payload: { ...first.payload, dialogueText: 'Changed prompt' }
      })
    ).toBe(false)
  })

  it('uses request IDs separately from idempotency and makes uninstall explicitly idempotent', () => {
    const first = {
      ...base('uninstall'),
      pluginId: 'demo.figplugin',
      host: 'figma',
      consent: consent(['uninstall'])
    }
    const replay = { ...first, requestId: 'uninstall-request-replay' }
    const conflict = { ...first, idempotencyKey: 'different-idempotency' }

    expect(isSameFigPluginCenterIdempotentOperation(first, replay)).toBe(true)
    expect(isSameFigPluginCenterIdempotentOperation(first, conflict)).toBe(false)
    expect(isFigPluginCenterPathCopyDisplayOnly(first as FigPluginCenterOperation)).toBe(false)

    const uninstallResponse = {
      schemaVersion: FIGPLUGIN_CENTER_SCHEMA_VERSION,
      requestId: 'uninstall-request',
      idempotencyKey: 'uninstall-idempotency',
      completedAt: '2026-01-01T00:00:00.000Z',
      kind: 'uninstall',
      ok: true,
      pluginId: 'demo.figplugin',
      host: 'figma',
      alreadyUninstalled: true,
      idempotent: true,
      status: {
        redacted: true,
        pluginId: 'demo.figplugin',
        host: 'figma',
        state: 'uninstalled',
        installed: false,
        configured: false,
        ready: false,
        activeCalls: 0
      }
    }
    expect(safeParseFigPluginCenterResponse(uninstallResponse).success).toBe(true)
  })
})
