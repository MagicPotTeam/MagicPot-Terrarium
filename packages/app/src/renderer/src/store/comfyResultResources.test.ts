import { configureStore } from '@reduxjs/toolkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResultItem } from '@shared/qApp/resultTypes'
import {
  createComfyResultAutoSaveClaimManager,
  createComfyResultResourceManager
} from './comfyResultResources'
import comfyStatusSlice, { appendResults, clearResults, deleteResult } from './slices/comfyStatus'

const imageResult = (id: string, objectUrl = `blob:${id}`): ResultItem => ({
  id,
  promptId: 'prompt',
  type: 'image',
  objectUrl,
  fileItem: { filename: `${id}.png`, subfolder: '', type: 'output' }
})

const textResult = (id: string): ResultItem => ({
  id,
  promptId: 'prompt',
  type: 'text',
  text: 'plain text',
  nodeId: 'node'
})

const createTestStore = (revokeObjectURL = vi.fn()) => {
  const manager = createComfyResultResourceManager(revokeObjectURL)
  let previousResults: ResultItem[] = []
  const store = configureStore({ reducer: { comfyStatus: comfyStatusSlice.reducer } })
  const unsubscribe = store.subscribe(() => {
    const currentResults = store.getState().comfyStatus.results
    manager.sync(previousResults, currentResults)
    previousResults = currentResults
  })
  return { store, manager, revokeObjectURL, unsubscribe }
}

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

describe('Quick App result auto-save claims', () => {
  const createClaimStore = () => {
    const claims = createComfyResultAutoSaveClaimManager()
    const store = configureStore({ reducer: { comfyStatus: comfyStatusSlice.reducer } })
    const unsubscribe = store.subscribe(() => claims.sync(store.getState().comfyStatus.results))
    cleanups.push(unsubscribe)
    return { claims, store }
  }

  it('atomically deduplicates retained remounts and permits retry after failure', () => {
    const { claims, store } = createClaimStore()
    store.dispatch(appendResults([imageResult('retained')]))

    expect(claims.claim('retained')).toBe(true)
    expect(claims.claim('retained')).toBe(false)
    claims.release('retained')
    expect(claims.claim('retained')).toBe(true)
  })

  it('never grows beyond the 20 retained results across more than 20 historical IDs', () => {
    const { claims, store } = createClaimStore()

    for (let batch = 0; batch < 3; batch += 1) {
      const results = Array.from({ length: 20 }, (_, index) =>
        imageResult(`result-${batch * 20 + index}`)
      )
      store.dispatch(appendResults(results))
      results.forEach((result) => claims.claim(result.id))
      expect(claims.size).toBe(20)
    }
  })

  it('prunes claims on deletion, capacity eviction, and clear', () => {
    const { claims, store } = createClaimStore()
    const oldest = imageResult('oldest')
    store.dispatch(appendResults([oldest]))
    claims.claim(oldest.id)

    const newer = Array.from({ length: 20 }, (_, index) => imageResult(`new-${index}`))
    store.dispatch(appendResults(newer))
    expect(claims.size).toBe(0)

    newer.forEach((result) => claims.claim(result.id))
    store.dispatch(deleteResult('new-0'))
    expect(claims.size).toBe(19)
    store.dispatch(clearResults())
    expect(claims.size).toBe(0)
  })

  it('clears all claims on teardown', () => {
    const claims = createComfyResultAutoSaveClaimManager()
    expect(claims.claim('before-teardown')).toBe(true)

    claims.teardown()

    expect(claims.size).toBe(0)
    expect(claims.claim('before-teardown')).toBe(true)
  })
})

describe('Quick App result blob resources', () => {
  it('revokes the 21st result evicted by the capacity limit', () => {
    const { store, revokeObjectURL, unsubscribe } = createTestStore()
    cleanups.push(unsubscribe)
    store.dispatch(appendResults([imageResult('oldest')]))
    store.dispatch(
      appendResults(Array.from({ length: 20 }, (_, index) => imageResult(`new-${index}`)))
    )

    expect(revokeObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:oldest')
  })

  it('revokes a blob URL after explicit deletion', () => {
    const { store, revokeObjectURL, unsubscribe } = createTestStore()
    cleanups.push(unsubscribe)
    store.dispatch(appendResults([imageResult('remove')]))
    store.dispatch(deleteResult('remove'))

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:remove')
  })

  it('does not revoke text results or non-blob URLs', () => {
    const { store, revokeObjectURL, unsubscribe } = createTestStore()
    cleanups.push(unsubscribe)
    store.dispatch(
      appendResults([textResult('text'), imageResult('remote', 'https://example.test/a.png')])
    )
    store.dispatch(clearResults())

    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('does not revoke the same blob URL twice across removal and teardown', () => {
    const { store, manager, revokeObjectURL, unsubscribe } = createTestStore()
    cleanups.push(unsubscribe)
    store.dispatch(appendResults([imageResult('duplicate')]))
    store.dispatch(deleteResult('duplicate'))
    manager.teardown()
    store.dispatch(deleteResult('duplicate'))

    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:duplicate')
  })
})
