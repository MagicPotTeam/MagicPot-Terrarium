import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

import {
  configureTextureAwareLoader,
  dummyTextureUrl,
  measureSceneDataLayout,
  tuneLoadedModelSceneForDisplay
} from './shared'

describe('measureSceneDataLayout', () => {
  it('derives centered bounds for off-origin object scenes', () => {
    const geometry = new THREE.BoxGeometry(4, 6, 2)
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
    mesh.position.set(10, -5, 3)
    const scene = new THREE.Group()
    scene.add(mesh)

    const layout = measureSceneDataLayout(scene)

    expect(layout).not.toBeNull()
    expect(layout?.modelCenter.x).toBeCloseTo(10)
    expect(layout?.modelCenter.y).toBeCloseTo(-5)
    expect(layout?.modelCenter.z).toBeCloseTo(3)
    expect(layout?.bounds.center.length()).toBeCloseTo(0)
    expect(layout?.bounds.size.x).toBeCloseTo(4)
    expect(layout?.bounds.size.y).toBeCloseTo(6)
    expect(layout?.bounds.size.z).toBeCloseTo(2)
  })

  it('derives centered bounds for translated buffer geometries', () => {
    const geometry = new THREE.BoxGeometry(2, 8, 4)
    geometry.translate(7, 1, -3)

    const layout = measureSceneDataLayout(geometry)

    expect(layout).not.toBeNull()
    expect(layout?.modelCenter.x).toBeCloseTo(7)
    expect(layout?.modelCenter.y).toBeCloseTo(1)
    expect(layout?.modelCenter.z).toBeCloseTo(-3)
    expect(layout?.bounds.center.length()).toBeCloseTo(0)
    expect(layout?.bounds.size.x).toBeCloseTo(2)
    expect(layout?.bounds.size.y).toBeCloseTo(8)
    expect(layout?.bounds.size.z).toBeCloseTo(4)
  })

  it('measures bounds against the requested initial rotation for viewer-facing scenes', () => {
    const geometry = new THREE.BoxGeometry(2, 8, 4)
    geometry.translate(7, 1, -3)

    const layout = measureSceneDataLayout(geometry, [0, Math.PI / 2, 0])

    expect(layout).not.toBeNull()
    expect(layout?.modelCenter.x).toBeCloseTo(-3)
    expect(layout?.modelCenter.y).toBeCloseTo(1)
    expect(layout?.modelCenter.z).toBeCloseTo(-7)
    expect(layout?.bounds.center.length()).toBeCloseTo(0)
    expect(layout?.bounds.size.x).toBeCloseTo(4)
    expect(layout?.bounds.size.y).toBeCloseTo(8)
    expect(layout?.bounds.size.z).toBeCloseTo(2)
  })

  it('normalizes texture decoding without overriding material factors', () => {
    const colorTexture = new THREE.Texture()
    const normalTexture = new THREE.Texture()
    const roughnessTexture = new THREE.Texture()
    const material = new THREE.MeshPhysicalMaterial({
      map: colorTexture,
      normalMap: normalTexture,
      roughnessMap: roughnessTexture
    })
    material.envMapIntensity = 0.4
    material.metalness = 1
    material.roughness = 0.18
    material.specularIntensity = 1.8
    material.specularColor.setRGB(2, 1.4, 0.6)
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)
    const scene = new THREE.Group()
    scene.add(mesh)

    tuneLoadedModelSceneForDisplay(scene, { maxAnisotropy: 16 })

    expect(colorTexture.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(normalTexture.colorSpace).toBe(THREE.NoColorSpace)
    expect(roughnessTexture.colorSpace).toBe(THREE.NoColorSpace)
    expect(colorTexture.anisotropy).toBe(8)
    expect(material.envMapIntensity).toBe(0.4)
    expect(material.metalness).toBe(1)
    expect(material.roughness).toBe(0.18)
    expect(material.specularIntensity).toBe(1)
    expect(material.specularColor.r).toBe(1)
    expect(material.specularColor.g).toBe(1)
    expect(material.specularColor.b).toBeCloseTo(0.6)
  })

  it('leaves bright textureless materials unchanged', () => {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(1, 1, 1),
      metalness: 0.9,
      roughness: 0.2
    })
    material.envMapIntensity = 1.4
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)
    const scene = new THREE.Group()
    scene.add(mesh)

    tuneLoadedModelSceneForDisplay(scene, { maxAnisotropy: 16 })

    expect(material.color.r).toBeCloseTo(1)
    expect(material.color.g).toBeCloseTo(1)
    expect(material.color.b).toBeCloseTo(1)
    expect(material.envMapIntensity).toBeCloseTo(1.4)
    expect(material.metalness).toBeCloseTo(0.9)
    expect(material.roughness).toBeCloseTo(0.2)
  })

  it('lifts near-black textureless materials so previews remain readable', () => {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0, 0, 0),
      metalness: 0.95,
      roughness: 0.08
    })
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material)
    const scene = new THREE.Group()
    scene.add(mesh)

    tuneLoadedModelSceneForDisplay(scene, { maxAnisotropy: 16 })

    const hsl = { h: 0, s: 0, l: 0 }
    material.color.getHSL(hsl)
    expect(hsl.l).toBeCloseTo(0.18, 2)
    expect(hsl.s).toBeCloseTo(0)
    expect(material.metalness).toBeCloseTo(0.95)
    expect(material.roughness).toBeCloseTo(0.08)
  })

  it('preserves embedded model texture blob urls while still falling back unknown textures', () => {
    const loader = new THREE.FileLoader()

    configureTextureAwareLoader(loader, 'blob:model.glb')

    expect(loader.manager.resolveURL('blob:embedded-texture')).toBe('blob:embedded-texture')
    expect(loader.manager.resolveURL('local-media://texture.png')).toBe('local-media://texture.png')
    expect(loader.manager.resolveURL('file:///C:/textures/albedo.png')).toBe(
      'file:///C:/textures/albedo.png'
    )
    expect(loader.manager.resolveURL('https://example.com/albedo.png')).toBe(
      'https://example.com/albedo.png'
    )
    expect(loader.manager.resolveURL('textures/missing.png')).toBe(dummyTextureUrl)
  })
})
