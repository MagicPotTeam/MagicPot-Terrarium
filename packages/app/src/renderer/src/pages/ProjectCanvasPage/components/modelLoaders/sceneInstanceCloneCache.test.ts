import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearCachedSceneInstanceClones,
  cloneSceneInstanceAsset,
  disposeSceneInstanceMaterials,
  getCachedSceneInstanceCloneCount,
  hasCachedSceneInstanceClone,
  peekCachedSceneInstanceCloneTemplate,
  readCachedSceneInstanceClone,
  retainSceneInstanceMaterials,
  writeCachedSceneInstanceClone
} from './sceneInstanceCloneCache'

const flushFinalRelease = async (): Promise<void> => {
  await Promise.resolve()
}

const objectMaterials = (object: THREE.Object3D): THREE.Material[] => {
  const materials: THREE.Material[] = []
  object.traverse((child) => {
    if (
      !(child as THREE.Mesh).isMesh &&
      !(child as THREE.Line).isLine &&
      !(child as THREE.Points).isPoints &&
      !(child as THREE.Sprite).isSprite
    ) {
      return
    }
    const childMaterials = (child as THREE.Mesh).material
    materials.push(...(Array.isArray(childMaterials) ? childMaterials : [childMaterials]))
  })
  return materials
}

describe('sceneInstanceCloneCache', () => {
  afterEach(() => {
    clearCachedSceneInstanceClones()
  })

  it('shares borrowed geometry and textures while isolating Mesh, Line, Points, and Sprite materials', () => {
    const geometry = new THREE.BufferGeometry()
    const texture = new THREE.Texture()
    const sharedMaterial = new THREE.MeshBasicMaterial({ map: texture })
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture })
    const template = new THREE.Group()
    template.add(new THREE.Mesh(geometry, sharedMaterial))
    template.add(new THREE.Line(geometry, sharedMaterial))
    template.add(new THREE.Points(geometry, sharedMaterial))
    template.add(new THREE.Sprite(spriteMaterial))

    const first = cloneSceneInstanceAsset(template)
    const second = cloneSceneInstanceAsset(template)
    const firstMaterials = objectMaterials(first)
    const secondMaterials = objectMaterials(second)

    expect(firstMaterials).toHaveLength(4)
    expect(new Set(firstMaterials).size).toBe(2)
    expect(firstMaterials[0]).not.toBe(sharedMaterial)
    expect(firstMaterials[3]).not.toBe(spriteMaterial)
    expect(secondMaterials[0]).not.toBe(firstMaterials[0])
    expect(secondMaterials[3]).not.toBe(firstMaterials[3])
    expect((firstMaterials[0] as THREE.MeshBasicMaterial).map).toBe(texture)
    expect((firstMaterials[3] as THREE.SpriteMaterial).map).toBe(texture)
    first.traverse((child) => {
      if (
        (child as THREE.Mesh).isMesh ||
        (child as THREE.Line).isLine ||
        (child as THREE.Points).isPoints
      ) {
        expect((child as THREE.Mesh).geometry).toBe(geometry)
      }
    })
  })

  it('keeps ShaderMaterial texture uniforms shared while cloning mutable uniform containers', () => {
    const geometry = new THREE.BoxGeometry()
    const texture = new THREE.Texture()
    const material = new THREE.ShaderMaterial({
      uniforms: {
        colorMap: { value: texture },
        nested: { value: { texture } }
      }
    })
    const clone = cloneSceneInstanceAsset(new THREE.Mesh(geometry, material)) as THREE.Mesh
    const clonedMaterial = clone.material as THREE.ShaderMaterial

    expect(clonedMaterial).not.toBe(material)
    expect(clonedMaterial.uniforms).not.toBe(material.uniforms)
    expect(clonedMaterial.uniforms.colorMap.value).toBe(texture)
    expect(clonedMaterial.uniforms.nested.value.texture).toBe(texture)
  })

  it('does not copy prototype-mutating material keys while restoring shared textures', () => {
    const texture = new THREE.Texture()
    const material = new THREE.MeshBasicMaterial()
    const expectedPrototype = THREE.MeshBasicMaterial.prototype
    vi.spyOn(material, 'clone').mockReturnValue(new THREE.MeshBasicMaterial())
    Object.defineProperties(material, {
      __proto__: { value: texture, enumerable: true, configurable: true },
      constructor: { value: texture, enumerable: true, configurable: true },
      prototype: { value: texture, enumerable: true, configurable: true }
    })

    const clone = cloneSceneInstanceAsset(
      new THREE.Mesh(new THREE.BoxGeometry(), material)
    ) as THREE.Mesh
    const clonedMaterial = clone.material as THREE.MeshBasicMaterial

    expect(Object.getPrototypeOf(clonedMaterial)).toBe(expectedPrototype)
    expect(Object.prototype.hasOwnProperty.call(clonedMaterial, 'constructor')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(clonedMaterial, 'prototype')).toBe(false)
  })

  it('isolates every material-array entry while retaining intra-instance sharing', () => {
    const geometry = new THREE.BoxGeometry()
    const sharedMaterial = new THREE.MeshStandardMaterial()
    const secondMaterial = new THREE.MeshStandardMaterial()
    const template = new THREE.Group()
    template.add(new THREE.Mesh(geometry, [sharedMaterial, secondMaterial]))
    template.add(new THREE.Mesh(geometry, sharedMaterial))

    const clone = cloneSceneInstanceAsset(template)
    const meshes: THREE.Mesh[] = []
    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh)
    })
    const firstMaterials = meshes[0].material as THREE.Material[]

    expect(firstMaterials[0]).not.toBe(sharedMaterial)
    expect(firstMaterials[1]).not.toBe(secondMaterial)
    expect(meshes[1].material).toBe(firstMaterials[0])
  })

  it('does not cache, clone, or dispose standalone borrowed BufferGeometry', () => {
    const geometry = new THREE.BoxGeometry()
    const clone = vi.spyOn(geometry, 'clone')
    const dispose = vi.spyOn(geometry, 'dispose')

    writeCachedSceneInstanceClone({ cacheKey: 'geometry', renderSceneData: geometry })

    expect(hasCachedSceneInstanceClone('geometry')).toBe(false)
    expect(readCachedSceneInstanceClone('geometry')).toBeNull()
    expect(clone).not.toHaveBeenCalled()
    clearCachedSceneInstanceClones()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('keeps a memoized instance live across a StrictMode-style cleanup/setup probe', async () => {
    const instance = cloneSceneInstanceAsset(
      new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    )
    const material = objectMaterials(instance)[0]
    const dispose = vi.spyOn(material, 'dispose')

    const firstRelease = retainSceneInstanceMaterials(instance)
    firstRelease()
    const secondRelease = retainSceneInstanceMaterials(instance)
    await flushFinalRelease()
    expect(dispose).not.toHaveBeenCalled()

    secondRelease()
    secondRelease()
    await flushFinalRelease()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes shared instance materials exactly once without owning geometry or textures', () => {
    const geometry = new THREE.BoxGeometry()
    const texture = new THREE.Texture()
    const material = new THREE.MeshStandardMaterial({ map: texture })
    const instance = cloneSceneInstanceAsset(new THREE.Mesh(geometry, material))
    const instanceMaterial = objectMaterials(instance)[0]
    const materialDispose = vi.spyOn(instanceMaterial, 'dispose')
    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const textureDispose = vi.spyOn(texture, 'dispose')

    disposeSceneInstanceMaterials(instance)
    disposeSceneInstanceMaterials(instance)

    expect(materialDispose).toHaveBeenCalledOnce()
    expect(geometryDispose).not.toHaveBeenCalled()
    expect(textureDispose).not.toHaveBeenCalled()
  })

  it('disposes replaced, evicted, and finally cleared cache templates exactly once', () => {
    const makeTemplate = () =>
      new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    const first = makeTemplate()
    writeCachedSceneInstanceClone({ cacheKey: 'a', renderSceneData: first, maxEntries: 2 })
    const firstCachedMaterial = objectMaterials(
      peekCachedSceneInstanceCloneTemplate('a') as THREE.Object3D
    )[0]
    const firstDispose = vi.spyOn(firstCachedMaterial, 'dispose')

    writeCachedSceneInstanceClone({ cacheKey: 'a', renderSceneData: makeTemplate(), maxEntries: 2 })
    expect(firstDispose).toHaveBeenCalledOnce()

    const replacementMaterial = objectMaterials(
      peekCachedSceneInstanceCloneTemplate('a') as THREE.Object3D
    )[0]
    const replacementDispose = vi.spyOn(replacementMaterial, 'dispose')
    writeCachedSceneInstanceClone({ cacheKey: 'b', renderSceneData: makeTemplate(), maxEntries: 2 })
    writeCachedSceneInstanceClone({ cacheKey: 'c', renderSceneData: makeTemplate(), maxEntries: 2 })
    expect(replacementDispose).toHaveBeenCalledOnce()
    expect(readCachedSceneInstanceClone('a')).toBeNull()
    expect(getCachedSceneInstanceCloneCount()).toBe(2)

    const remainingDisposes = ['b', 'c'].map((key) =>
      vi.spyOn(
        objectMaterials(peekCachedSceneInstanceCloneTemplate(key) as THREE.Object3D)[0],
        'dispose'
      )
    )
    clearCachedSceneInstanceClones()
    clearCachedSceneInstanceClones()
    remainingDisposes.forEach((dispose) => expect(dispose).toHaveBeenCalledOnce())
    expect(getCachedSceneInstanceCloneCount()).toBe(0)
  })
})
