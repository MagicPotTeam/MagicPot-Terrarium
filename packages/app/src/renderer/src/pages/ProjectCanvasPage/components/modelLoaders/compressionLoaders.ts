import * as THREE from 'three'
import { DRACOLoader, GLTFLoader, KTX2Loader, MeshoptDecoder } from 'three-stdlib'

const DRACO_DECODER_PUBLIC_DIR = 'three/draco/gltf/'
const KTX2_TRANSCODER_PUBLIC_DIR = 'three/basis/'

type KTX2LoaderWithState = KTX2Loader & {
  __magicpotSupportReady?: boolean
}

const dracoLoadersByManager = new WeakMap<THREE.LoadingManager, DRACOLoader>()
const ktx2LoadersByManager = new WeakMap<THREE.LoadingManager, KTX2LoaderWithState>()

export const normalizeRendererPublicBaseUrl = (baseUrl: string) => {
  if (!baseUrl) return './'
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
}

export const resolveRendererPublicAssetUrl = (
  relativePath: string,
  baseUrl: string = import.meta.env.BASE_URL,
  locationHref: string = typeof window !== 'undefined' ? window.location.href : 'http://localhost/'
) => {
  const normalizedRelativePath = relativePath.replace(/^\/+/, '')
  return new URL(
    `${normalizeRendererPublicBaseUrl(baseUrl)}${normalizedRelativePath}`,
    locationHref
  ).toString()
}

const getOrCreateDracoLoader = (manager: THREE.LoadingManager) => {
  let loader = dracoLoadersByManager.get(manager)
  if (!loader) {
    loader = new DRACOLoader(manager)
    loader.setDecoderPath(resolveRendererPublicAssetUrl(DRACO_DECODER_PUBLIC_DIR))
    loader.setDecoderConfig({ type: 'wasm' })
    dracoLoadersByManager.set(manager, loader)
  }

  return loader
}

const getOrCreateKTX2Loader = (manager: THREE.LoadingManager, renderer: THREE.WebGLRenderer) => {
  let loader = ktx2LoadersByManager.get(manager)
  if (!loader) {
    loader = new KTX2Loader(manager) as KTX2LoaderWithState
    loader.setTranscoderPath(resolveRendererPublicAssetUrl(KTX2_TRANSCODER_PUBLIC_DIR))
    ktx2LoadersByManager.set(manager, loader)
  }

  if (!loader.__magicpotSupportReady) {
    loader.detectSupport(renderer)
    loader.__magicpotSupportReady = true
  }

  return loader
}

export const configureGLTFCompressionLoaders = (
  loader: GLTFLoader,
  renderer: THREE.WebGLRenderer
) => {
  loader.setDRACOLoader(getOrCreateDracoLoader(loader.manager))
  loader.setKTX2Loader(getOrCreateKTX2Loader(loader.manager, renderer))
  loader.setMeshoptDecoder(MeshoptDecoder)
}
