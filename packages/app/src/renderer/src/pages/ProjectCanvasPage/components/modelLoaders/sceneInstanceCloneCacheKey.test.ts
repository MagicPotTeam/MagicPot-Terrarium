import { describe, expect, it } from 'vitest'

import {
  getSceneInstanceCloneAssetSignature,
  getSceneInstanceCloneCacheKey,
  getSceneInstanceCloneTextureSignature
} from './sceneInstanceCloneCacheKey'

describe('sceneInstanceCloneCacheKey', () => {
  it('sorts texture entries to produce a stable signature', () => {
    expect(
      getSceneInstanceCloneTextureSignature({
        'z.png': 'blob:z',
        'a.png': 'blob:a'
      })
    ).toBe('a.png:blob:a|z.png:blob:z')
  })

  it('distinguishes cache keys by session key', () => {
    const textures = { 'preview.png': 'blob:preview' }

    expect(
      getSceneInstanceCloneCacheKey({
        sessionKey: 'canvas:thread:project-1:thread:agent-1',
        src: 'https://example.com/model.glb',
        itemId: 'item-1',
        textures
      })
    ).not.toBe(
      getSceneInstanceCloneCacheKey({
        sessionKey: 'canvas:thread:project-1:thread:agent-2',
        src: 'https://example.com/model.glb',
        itemId: 'item-1',
        textures
      })
    )
  })

  it('reuses the same cache key for the same session and model asset identity', () => {
    const textures = { 'preview.png': 'blob:preview' }

    expect(
      getSceneInstanceCloneCacheKey({
        sessionKey: 'canvas:thread:project-1:thread:agent-1',
        src: 'https://example.com/model.glb',
        itemId: 'item-1',
        textures
      })
    ).toBe(
      getSceneInstanceCloneCacheKey({
        sessionKey: 'canvas:thread:project-1:thread:agent-1',
        src: 'https://example.com/model.glb',
        itemId: 'item-1',
        textures
      })
    )
  })

  it('shares the cache key across different items when the session and asset source match', () => {
    const textures = { 'preview.png': 'blob:preview' }

    expect(
      getSceneInstanceCloneCacheKey({
        sessionKey: 'canvas:thread:project-1:thread:agent-1',
        src: 'https://example.com/model.glb',
        itemId: 'item-1',
        textures
      })
    ).toBe(
      getSceneInstanceCloneCacheKey({
        sessionKey: 'canvas:thread:project-1:thread:agent-1',
        src: 'https://example.com/model.glb',
        itemId: 'item-2',
        textures
      })
    )
  })

  it('distinguishes cache keys when the model source changes for the same item', () => {
    expect(
      getSceneInstanceCloneCacheKey({
        sessionKey: 'canvas:thread:project-1',
        src: 'https://example.com/model-a.glb',
        itemId: 'item-1'
      })
    ).not.toBe(
      getSceneInstanceCloneCacheKey({
        sessionKey: 'canvas:thread:project-1',
        src: 'https://example.com/model-b.glb',
        itemId: 'item-1'
      })
    )
  })

  it('falls back to file name and never treats local item ids as canonical clone identities', () => {
    expect(
      getSceneInstanceCloneAssetSignature({
        fileName: 'model.glb',
        itemId: 'item-1'
      })
    ).toBe('render-v4:file:model.glb:no-textures')

    expect(
      getSceneInstanceCloneAssetSignature({
        itemId: 'item-1'
      })
    ).toBe('render-v4:unknown-model:no-textures')

    expect(
      getSceneInstanceCloneAssetSignature({
        itemId: 'item-1'
      })
    ).toBe(
      getSceneInstanceCloneAssetSignature({
        itemId: 'item-2'
      })
    )
  })
})
