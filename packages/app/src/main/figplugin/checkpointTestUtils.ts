import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { HostContext, HostPlan } from '@shared/figplugin/hostPlan'
import { captureTaskRecoveryScope } from '@shared/figplugin/taskRecovery'
import { canonicalFigPluginJson } from '@shared/figplugin/manifest'
import type { FigPluginRuntimeBinding } from '@shared/figplugin/bridge'
import type { CheckpointCodec, SavedCheckpoint } from './checkpointStore'
export const NOW = 1_900_000_000_000
export const hash = (value: unknown): string =>
  createHash('sha256').update(canonicalFigPluginJson(value)).digest('hex')
export const binding: FigPluginRuntimeBinding = {
  pluginId: 'owned.checkpoint',
  host: 'figma',
  generation: 1,
  artifactSha256: 'a'.repeat(64),
  manifestSha256: 'b'.repeat(64),
  signerFingerprint: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:41234',
  projectId: 'owned-project',
  profileId: 'owned-model',
  profileRevision: 'd'.repeat(64)
}
export const context: HostContext = {
  version: 1,
  host: 'figma',
  documentId: 'owned-document',
  scopeId: 'owned-page',
  captureId: '1'.repeat(32),
  recoveryIdentity: '2'.repeat(32),
  selectedIds: ['owned-node'],
  nodes: [
    {
      id: 'owned-node',
      type: 'RECTANGLE',
      name: 'Original',
      parentId: 'owned-page',
      ancestors: [{ id: 'owned-page', type: 'PAGE', locked: false }],
      locked: false,
      visible: true,
      opacity: 1,
      commands: ['node.rename']
    }
  ],
  execution: {
    mode: 'native-write',
    adapterVersion: 'figma-native-1',
    supports: ['node.rename'],
    rollback: 'verified-in-place',
    visualAudit: 'hash-only'
  }
}
export const plan: HostPlan = {
  schemaVersion: 2,
  kind: 'host-plan',
  captureId: context.captureId,
  steps: [
    { command: 'node.rename', targetId: 'owned-node', name: 'PRIVATE_OWNED_DESIGN_TEXT_恢复点' }
  ]
}
export function record(seed = 3): SavedCheckpoint {
  const evidence = [
    {
      targetId: 'owned-node',
      before: { sha256: '4'.repeat(64), width: 2, height: 1 },
      after: { sha256: '5'.repeat(64), width: 2, height: 1 },
      changed: true
    }
  ]
  return {
    value: {
      protocol: 1,
      baselineId: seed.toString(16).padStart(32, '0'),
      sourceExecutionId: (seed + 1).toString(16).padStart(32, '0'),
      pluginId: binding.pluginId,
      host: binding.host,
      projectId: binding.projectId,
      documentId: context.documentId,
      scopeId: context.scopeId,
      captureId: context.captureId,
      planSha256: hash(plan),
      contextSha256: hash(context),
      visualEvidenceSha256: hash(evidence),
      adapterVersion: context.execution!.adapterVersion,
      targets: [{ targetId: 'owned-node', accepted: evidence[0].after }],
      acceptedAt: NOW,
      expiresAt: NOW + 86400000,
      correctionRoundsUsed: 0,
      maxCorrectionRounds: 3,
      storage: 'encrypted-local'
    },
    binding: structuredClone(binding),
    recoveryPlan: structuredClone(plan),
    recoveryScope: captureTaskRecoveryScope(plan, context) as SavedCheckpoint['recoveryScope']
  }
}
/** Real authenticated encryption with an owned synthetic test key, not OS safeStorage. */
export function ownedCodec(key: Buffer = randomBytes(32)): CheckpointCodec {
  return {
    available: () => true,
    encrypt(text) {
      const iv = randomBytes(12),
        c = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, c.update(text, 'utf8'), c.final(), c.getAuthTag()])
    },
    decrypt(data) {
      const d = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      d.setAuthTag(data.subarray(-16))
      return Buffer.concat([d.update(data.subarray(12, -16)), d.final()]).toString('utf8')
    }
  }
}
