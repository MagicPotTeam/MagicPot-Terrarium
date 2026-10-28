import { describe, expect, it } from 'vitest'
import {
  applyTaskRecoveryRebind,
  createTaskRecoveryRebind,
  taskRecoveryDocumentRebindSchema,
  type TaskRecoveryScope
} from './taskRecovery'
import type { HostContext } from './hostPlan'
const scope: TaskRecoveryScope = {
  host: 'photoshop',
  documentId: '101',
  scopeId: '101',
  adapterVersion: 'ps-1',
  targetIds: ['7'],
  recoveryIdentity: 'a'.repeat(32),
  anchors: [{ id: '7', type: 'pixel', parentId: null, ancestors: [] }]
}
const context: HostContext = {
  version: 1,
  host: 'photoshop',
  documentId: '202',
  scopeId: '202',
  captureId: 'c'.repeat(32),
  recoveryIdentity: 'b'.repeat(32),
  selectedIds: ['7'],
  nodes: [
    {
      id: '7',
      type: 'pixel',
      name: 'Current',
      parentId: null,
      ancestors: [],
      locked: false,
      visible: true,
      commands: ['node.rename']
    }
  ],
  execution: {
    mode: 'native-write',
    adapterVersion: 'ps-1',
    rollback: 'verified-in-place',
    visualAudit: 'hash-only',
    supports: ['node.rename']
  }
}
describe('root-only reopened document projection', () => {
  it('never changes any layer or hierarchy anchor and does not mutate the old checkpoint', () => {
    const before = structuredClone(scope)
    expect(() => createTaskRecoveryRebind(scope, context)).toThrow()
    const rebind = createTaskRecoveryRebind(scope, context, true)!
    const result = applyTaskRecoveryRebind(scope, rebind)
    expect(result).toEqual({
      ...scope,
      documentId: '202',
      scopeId: '202',
      recoveryIdentity: context.recoveryIdentity
    })
    expect(scope).toEqual(before)
    expect(result.anchors).toEqual(before.anchors)
  })
  it.each(['0', '-1', '01', '1.0', '101\n', '9007199254740992', 'PRIVATE', '101 '])(
    'refuses invalid document ID %j',
    (id) => {
      expect(
        taskRecoveryDocumentRebindSchema.safeParse({
          host: 'photoshop',
          previousDocumentId: id,
          nextDocumentId: '202'
        }).success
      ).toBe(false)
    }
  )
  it('refuses Figma document/page remapping and invalid Photoshop scope', () => {
    expect(() =>
      createTaskRecoveryRebind({ ...scope, host: 'figma' }, { ...context, host: 'figma' }, true)
    ).toThrow()
    expect(() => createTaskRecoveryRebind({ ...scope, scopeId: 'page' }, context, true)).toThrow()
    expect(() => createTaskRecoveryRebind(scope, { ...context, scopeId: 'page' }, true)).toThrow()
  })
  it('retains legacy same-document explicit instance reassociation without document metadata', () => {
    const r = createTaskRecoveryRebind(scope, { ...context, documentId: '101', scopeId: '101' })!
    expect(r).toEqual({
      previousIdentity: scope.recoveryIdentity,
      nextIdentity: context.recoveryIdentity
    })
    expect(
      createTaskRecoveryRebind(scope, {
        ...context,
        documentId: '101',
        scopeId: '101',
        recoveryIdentity: scope.recoveryIdentity
      })
    ).toBeUndefined()
  })
  it('cannot apply a stale identity or old document mapping to a changed checkpoint', () => {
    const r = createTaskRecoveryRebind(scope, context, true)!
    expect(() =>
      applyTaskRecoveryRebind({ ...scope, recoveryIdentity: 'f'.repeat(32) }, r)
    ).toThrow()
    expect(() =>
      applyTaskRecoveryRebind({ ...scope, documentId: '404', scopeId: '404' }, r)
    ).toThrow()
    expect(() =>
      createTaskRecoveryRebind(
        scope,
        { ...context, recoveryIdentity: scope.recoveryIdentity },
        true
      )
    ).toThrow()
  })
})
