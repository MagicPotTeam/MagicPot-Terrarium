/* eslint-disable react/no-unknown-property */
/* eslint-disable react-refresh/only-export-components */
import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { getCanvasItemBounds } from '../projectCanvasPageShared'
import { getCanvasViewportBounds } from '../canvasViewportPlacementUtils'
import type { CanvasModel3DItem } from '../types'
import { ModelSceneCanvasSetup, type ModelBounds } from './modelLoaders/shared'
import { PROJECT_CANVAS_MIN_STAGE_SCALE } from '../projectCanvasViewportScale'
import type { CanvasSyncDetail } from './canvasSync'
import {
  readCanvas3DStageModelBoundsCache,
  writeCanvas3DStageModelBoundsCache
} from './canvas3DStageModelBoundsCache'
import {
  getCanvas3DStagePreviewTextureKey,
  getOrCreateCanvas3DStagePreviewTexture,
  readCanvas3DStagePreviewTexture
} from './canvas3DStagePreviewTextureCache'
import {
  DEFAULT_CANVAS_MODEL3D_SESSION_KEY,
  getSceneInstanceCloneCacheKey
} from './modelLoaders/sceneInstanceCloneCacheKey'
import {
  areCanvas3DStagePropsEqual,
  areCanvas3DStageRenderKickPropsEqual
} from './canvas3DStageMemo'
import {
  areCanvas3DStageModelItemRenderStatesEqual,
  type Canvas3DStageModelItemRenderState
} from './canvas3DStageModelItemMemo'
import {
  areCanvas3DStageIdSetsEqual,
  getCanvas3DStageItemDisplayMetrics,
  MIN_MODEL_RENDER_SIZE_PX,
  MODEL_LOAD_BATCH_DELAY_MS,
  resolveCanvas3DStageActivatedIds,
  resolveCanvas3DStageActivationBatchPolicy,
  resolveCanvas3DStageLoadQueue,
  resolveCanvas3DStageNextActivationBatch
} from './canvas3DStageLoadQueue'
import {
  resolveCanvas3DStageLightingPreset,
  resolveCanvas3DStageMountedIds,
  CANVAS_3D_STAGE_VIEWPORT_SETTLE_MS,
  resolveCanvas3DStageDpr,
  resolveCanvas3DStageRenderPumpFrames,
  resolveCanvas3DStageFrameloop,
  shouldCanvas3DStageRenderLighting
} from './canvas3DStageQuality'
import type { Canvas3DStageLightingPreset } from './canvas3DStageQuality'
import {
  CANVAS_3D_STAGE_PREVIEW_MODEL_ROTATION,
  CANVAS_3D_VIEWER_CAMERA_DIRECTION,
  resolveCanvas3DStageLightingConfig
} from './canvas3DStagePresentation'

const GLTFScene = lazy(() => import('./modelLoaders/GLTFScene'))
const FBXScene = lazy(() => import('./modelLoaders/FBXScene'))
const OBJScene = lazy(() => import('./modelLoaders/OBJScene'))
const STLScene = lazy(() => import('./modelLoaders/STLScene'))

const DEG_TO_RAD = Math.PI / 180
const PREVIEW_FILL_RATIO = 0.92
const PREVIEW_MIN_EXTENT = 0.001
const DEFAULT_MODEL_BOUNDS_SIZE = new THREE.Vector3(0.72, 1.45, 0.72)
const DEFAULT_CAMERA_DIRECTION = new THREE.Vector3(...CANVAS_3D_VIEWER_CAMERA_DIRECTION).normalize()
const UNIT_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1)
const UNIT_BOX_EDGES_GEOMETRY = new THREE.EdgesGeometry(UNIT_BOX_GEOMETRY)
const UNIT_PLANE_GEOMETRY = new THREE.PlaneGeometry(1, 1)

const CANVAS_3D_STAGE_VISIBLE_OVERSCAN_PX = 240
const ENABLE_CANVAS_3D_STAGE_VIEWPORT_FREEZE = false
const FREEZE_FRAME_CONTENT_SAMPLE_SIZE = 96

export const CANVAS_3D_STAGE_GL_OPTIONS = {
  alpha: true,
  antialias: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: false,
  stencil: false
} as const

type Canvas3DStageViewportSummary = {
  visibleItemIds: Set<string>
  viewportCulledCount: number
}

type Canvas3DStageViewportState = {
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize: { width: number; height: number }
}

type Canvas3DStageFreezeFrameSnapshot = {
  canvas: HTMLCanvasElement
  viewport: Canvas3DStageViewportState
}

type Canvas3DStageFreezeFrameTransform = {
  scale: number
  translateX: number
  translateY: number
  transform: string
}

export const resolveCanvas3DStageViewportSummary = ({
  items,
  selectedIds,
  stagePos,
  stageScale,
  stageSize,
  overscanPx = CANVAS_3D_STAGE_VISIBLE_OVERSCAN_PX,
  skipViewportCulling = false
}: {
  items: CanvasModel3DItem[]
  selectedIds: ReadonlySet<string>
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize: { width: number; height: number }
  overscanPx?: number
  skipViewportCulling?: boolean
}): Canvas3DStageViewportSummary => {
  if (items.length === 0 || stageSize.width <= 0 || stageSize.height <= 0 || skipViewportCulling) {
    return {
      visibleItemIds: new Set(items.map((item) => item.id)),
      viewportCulledCount: 0
    }
  }

  const safeScale = Math.max(Math.abs(stageScale), PROJECT_CANVAS_MIN_STAGE_SCALE)
  const overscan = overscanPx / safeScale
  const viewport = getCanvasViewportBounds(stagePos, stageSize, safeScale)
  const minX = viewport.x - overscan
  const minY = viewport.y - overscan
  const maxX = viewport.x + viewport.width + overscan
  const maxY = viewport.y + viewport.height + overscan
  const visibleItemIds = new Set<string>()
  let viewportCulledCount = 0

  for (const item of items) {
    if (selectedIds.has(item.id)) {
      visibleItemIds.add(item.id)
      continue
    }

    const bounds = getCanvasItemBounds(item)
    const intersectsViewport =
      bounds.maxX > minX && bounds.minX < maxX && bounds.maxY > minY && bounds.minY < maxY

    if (intersectsViewport) {
      visibleItemIds.add(item.id)
      continue
    }

    viewportCulledCount += 1
  }

  return {
    visibleItemIds,
    viewportCulledCount
  }
}

const createCanvas3DStageViewportState = ({
  stagePos,
  stageScale,
  stageSize
}: Canvas3DStageViewportState): Canvas3DStageViewportState => ({
  stagePos: {
    x: stagePos.x,
    y: stagePos.y
  },
  stageScale,
  stageSize: {
    width: stageSize.width,
    height: stageSize.height
  }
})

const hasCanvas3DStageFreezeFrameContent = (
  snapshotCanvas: HTMLCanvasElement,
  snapshotContext: CanvasRenderingContext2D
) => {
  const width = snapshotCanvas.width
  const height = snapshotCanvas.height
  if (width <= 0 || height <= 0) {
    return false
  }

  const sampleWidth = Math.max(1, Math.min(FREEZE_FRAME_CONTENT_SAMPLE_SIZE, width))
  const sampleHeight = Math.max(1, Math.min(FREEZE_FRAME_CONTENT_SAMPLE_SIZE, height))
  let sampleContext = snapshotContext

  if (sampleWidth !== width || sampleHeight !== height) {
    const sampleCanvas = document.createElement('canvas')
    sampleCanvas.width = sampleWidth
    sampleCanvas.height = sampleHeight
    const nextSampleContext = sampleCanvas.getContext('2d')
    if (!nextSampleContext) {
      return true
    }

    nextSampleContext.drawImage(snapshotCanvas, 0, 0, sampleWidth, sampleHeight)
    sampleContext = nextSampleContext
  }

  try {
    const pixels = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data
    for (let alphaIndex = 3; alphaIndex < pixels.length; alphaIndex += 4) {
      if (pixels[alphaIndex] > 0) {
        return true
      }
    }
    return false
  } catch {
    return true
  }
}

export const resolveCanvas3DStageFreezeFrameTransform = ({
  snapshotViewport,
  currentViewport
}: {
  snapshotViewport: Canvas3DStageViewportState
  currentViewport: Canvas3DStageViewportState
}): Canvas3DStageFreezeFrameTransform | null => {
  if (
    snapshotViewport.stageSize.width <= 0 ||
    snapshotViewport.stageSize.height <= 0 ||
    currentViewport.stageSize.width !== snapshotViewport.stageSize.width ||
    currentViewport.stageSize.height !== snapshotViewport.stageSize.height
  ) {
    return null
  }

  const snapshotScale = Math.max(snapshotViewport.stageScale, PROJECT_CANVAS_MIN_STAGE_SCALE)
  const currentScale = Math.max(currentViewport.stageScale, PROJECT_CANVAS_MIN_STAGE_SCALE)
  const scale = currentScale / snapshotScale
  const translateX = currentViewport.stagePos.x - snapshotViewport.stagePos.x * scale
  const translateY = currentViewport.stagePos.y - snapshotViewport.stagePos.y * scale

  return {
    scale,
    translateX,
    translateY,
    transform: `matrix(${scale}, 0, 0, ${scale}, ${translateX}, ${translateY})`
  }
}

const cloneBounds = (bounds: ModelBounds): ModelBounds => ({
  center: bounds.center.clone(),
  size: bounds.size.clone(),
  radius: bounds.radius
})

const areBoundsSimilar = (prev: ModelBounds | null, next: ModelBounds) => {
  if (!prev) return false

  const epsilon = 0.001
  return (
    Math.abs(prev.radius - next.radius) <= epsilon &&
    prev.center.distanceToSquared(next.center) <= epsilon &&
    prev.size.distanceToSquared(next.size) <= epsilon
  )
}

const getProjectedFootprint = (size: THREE.Vector3, rotation: [number, number, number]) => {
  const halfExtents = size.clone().multiplyScalar(0.5)
  const rotationMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation))
  const elements = rotationMatrix.elements
  const extentX =
    Math.abs(elements[0]) * halfExtents.x +
    Math.abs(elements[4]) * halfExtents.y +
    Math.abs(elements[8]) * halfExtents.z
  const extentY =
    Math.abs(elements[1]) * halfExtents.x +
    Math.abs(elements[5]) * halfExtents.y +
    Math.abs(elements[9]) * halfExtents.z

  return {
    width: Math.max(extentX * 2, PREVIEW_MIN_EXTENT),
    height: Math.max(extentY * 2, PREVIEW_MIN_EXTENT)
  }
}

const getPreviewFitScale = ({
  canvasWidth,
  canvasHeight,
  bounds
}: {
  canvasWidth: number
  canvasHeight: number
  bounds: ModelBounds | null
}) => {
  const size = bounds?.size ?? DEFAULT_MODEL_BOUNDS_SIZE
  const footprint = getProjectedFootprint(size, CANVAS_3D_STAGE_PREVIEW_MODEL_ROTATION)
  const targetWidth = Math.max(canvasWidth * PREVIEW_FILL_RATIO, 1)
  const targetHeight = Math.max(canvasHeight * PREVIEW_FILL_RATIO, 1)
  const widthScale = targetWidth / footprint.width
  const heightScale = targetHeight / footprint.height

  return Math.max(Math.min(widthScale, heightScale), PREVIEW_MIN_EXTENT)
}

type Canvas3DStageProps = {
  items: CanvasModel3DItem[]
  selectedIds: Set<string>
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize: { width: number; height: number }
  sessionKey?: string
  isViewportInteracting?: boolean
  onViewportSyncReady?: (sync: Canvas3DStageViewportSync | null) => void
}

export type Canvas3DStageViewportSync = (
  stagePos: { x: number; y: number },
  stageScale: number
) => void

export type Canvas3DViewerQualityPreset = {
  dpr: [number, number]
  ambientIntensity: number
  hemisphereIntensity: number
  directionalLights: Array<{
    position: [number, number, number]
    intensity: number
  }>
}

export const resolveStageDecorationDirectionalLights = (
  lightingPreset: Canvas3DStageLightingPreset
): Array<{
  position: [number, number, number]
  intensity: number
}> => resolveCanvas3DStageLightingConfig(lightingPreset).directionalLights

type Canvas3DViewerSurfaceProps = {
  item: CanvasModel3DItem
  qualityPreset: Canvas3DViewerQualityPreset
  instanceCacheKey?: string
  renderKey?: string
  onError?: (message: string) => void
}

type OrbitControlsLike = {
  target: THREE.Vector3
  update: () => void
  minDistance: number
  maxDistance: number
}

type ModelSceneEventMap = {
  'model-centered': {
    type: 'model-centered'
    center?: THREE.Vector3
    size?: THREE.Vector3
    radius?: number
  }
}

const asOrbitControls = (controls: unknown): OrbitControlsLike | null => {
  if (!controls || typeof controls !== 'object') return null

  const maybeControls = controls as Partial<OrbitControlsLike>
  if (
    !(maybeControls.target instanceof THREE.Vector3) ||
    typeof maybeControls.update !== 'function'
  ) {
    return null
  }

  return maybeControls as OrbitControlsLike
}

const asModelSceneDispatcher = (scene: THREE.Scene): THREE.EventDispatcher<ModelSceneEventMap> =>
  scene as unknown as THREE.EventDispatcher<ModelSceneEventMap>

class ModelRenderBoundary extends React.Component<
  { children: React.ReactNode; isSelected: boolean },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; isSelected: boolean }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.error('[Canvas] Unified 3D stage failed to render model:', error)
  }

  render() {
    if (this.state.hasError) {
      return <FallbackModel isSelected={this.props.isSelected} />
    }

    return this.props.children
  }
}

class ViewerModelRenderBoundary extends React.Component<
  { children: React.ReactNode; onError?: (message: string) => void },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; onError?: (message: string) => void }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.error('[Canvas] Unified 3D viewer failed to render model:', error)
    const message = error instanceof Error ? error.message : String(error)
    this.props.onError?.(message)
  }

  render() {
    if (this.state.hasError) {
      return null
    }

    return this.props.children
  }
}

const StageCameraSync: React.FC<{
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize: { width: number; height: number }
}> = ({ stagePos, stageScale, stageSize }) => {
  const { camera, invalidate } = useThree()

  useLayoutEffect(() => {
    if (!syncCanvas3DStageCamera({ camera, stagePos, stageScale, stageSize })) return
    invalidate()
  }, [camera, invalidate, stagePos, stageScale, stageSize])

  return null
}

const StageImperativeViewportSync: React.FC<{
  stageSize: { width: number; height: number }
  onRegisterSync: (sync: Canvas3DStageViewportSync | null) => void
}> = ({ stageSize, onRegisterSync }) => {
  const { camera, invalidate } = useThree()

  useLayoutEffect(() => {
    onRegisterSync((nextStagePos, nextStageScale) => {
      if (
        !syncCanvas3DStageCamera({
          camera,
          stagePos: nextStagePos,
          stageScale: nextStageScale,
          stageSize
        })
      ) {
        return
      }

      invalidate()
    })

    return () => {
      onRegisterSync(null)
    }
  }, [camera, invalidate, onRegisterSync, stageSize])

  return null
}

export const configureCanvas3DStageRenderer = (gl: THREE.WebGLRenderer) => {
  gl.autoClear = true
  gl.setClearColor(0x000000, 0)
}

const clearCanvas3DStageRenderer = (gl: THREE.WebGLRenderer) => {
  configureCanvas3DStageRenderer(gl)
  gl.clear(true, true, true)
}

const StageRendererSync: React.FC = () => {
  const { gl, invalidate } = useThree()

  useLayoutEffect(() => {
    const previousAutoClear = gl.autoClear
    const previousClearColor = gl.getClearColor(new THREE.Color()).clone()
    const previousClearAlpha = gl.getClearAlpha()

    configureCanvas3DStageRenderer(gl)
    invalidate()

    return () => {
      gl.autoClear = previousAutoClear
      gl.setClearColor(previousClearColor, previousClearAlpha)
    }
  }, [gl, invalidate])

  useFrame(() => {
    clearCanvas3DStageRenderer(gl)
  }, -1000)

  return null
}

export const syncCanvas3DStageCamera = ({
  camera,
  stagePos,
  stageScale,
  stageSize
}: {
  camera: THREE.Camera
  stagePos: { x: number; y: number }
  stageScale: number
  stageSize: { width: number; height: number }
}) => {
  if (!(camera instanceof THREE.OrthographicCamera)) {
    return false
  }

  const safeScale = Math.max(stageScale, PROJECT_CANVAS_MIN_STAGE_SCALE)
  camera.left = -stageSize.width / 2
  camera.right = stageSize.width / 2
  camera.top = stageSize.height / 2
  camera.bottom = -stageSize.height / 2
  camera.zoom = safeScale
  camera.near = 0.1
  camera.far = 5000
  camera.position.set(
    (stageSize.width / 2 - stagePos.x) / safeScale,
    (stagePos.y - stageSize.height / 2) / safeScale,
    1000
  )
  camera.lookAt(camera.position.x, camera.position.y, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)

  return true
}

const LoadingModel: React.FC<{ isSelected: boolean }> = ({ isSelected }) => (
  <mesh
    castShadow={false}
    receiveShadow={false}
    geometry={UNIT_BOX_GEOMETRY}
    scale={[1.8, 1.8, 1.8]}
  >
    <meshBasicMaterial
      color={isSelected ? '#60a5fa' : '#475569'}
      wireframe
      opacity={0.6}
      transparent
    />
  </mesh>
)

const TinyModelPlaceholder: React.FC<{ isSelected: boolean }> = ({ isSelected }) => (
  <group scale={[1.35, 1.35, 1.35]}>
    <mesh castShadow={false} receiveShadow={false} geometry={UNIT_BOX_GEOMETRY}>
      <meshBasicMaterial color={isSelected ? '#60a5fa' : '#334155'} opacity={0.9} transparent />
    </mesh>
    <lineSegments geometry={UNIT_BOX_EDGES_GEOMETRY}>
      <lineBasicMaterial color={isSelected ? '#bfdbfe' : '#94a3b8'} />
    </lineSegments>
  </group>
)

const DeferredModelPlaceholder: React.FC<{ isSelected: boolean }> = ({ isSelected }) => (
  <group scale={[1.6, 1.6, 1.6]}>
    <mesh castShadow={false} receiveShadow={false} geometry={UNIT_BOX_GEOMETRY}>
      <meshBasicMaterial color={isSelected ? '#60a5fa' : '#1e293b'} opacity={0.72} transparent />
    </mesh>
    <lineSegments geometry={UNIT_BOX_EDGES_GEOMETRY}>
      <lineBasicMaterial color={isSelected ? '#bfdbfe' : '#64748b'} />
    </lineSegments>
  </group>
)

const CachedPreviewModel: React.FC<{
  texture: THREE.Texture
  width: number
  height: number
  isSelected: boolean
}> = ({ texture, width, height, isSelected }) => (
  <group>
    <mesh
      position={[0, 0, -0.04]}
      renderOrder={-1}
      geometry={UNIT_PLANE_GEOMETRY}
      scale={[width * 1.04, height * 1.04, 1]}
    >
      <meshBasicMaterial
        color={isSelected ? '#60a5fa' : '#0f172a'}
        opacity={isSelected ? 0.16 : 0.1}
        transparent
        depthWrite={false}
      />
    </mesh>
    <mesh renderOrder={0} geometry={UNIT_PLANE_GEOMETRY} scale={[width, height, 1]}>
      <meshBasicMaterial
        map={texture}
        opacity={isSelected ? 0.98 : 0.94}
        transparent
        toneMapped={false}
        depthWrite={false}
      />
    </mesh>
  </group>
)

const FallbackModel: React.FC<{ isSelected: boolean }> = ({ isSelected }) => (
  <group scale={[1.8, 1.8, 1.8]}>
    <mesh castShadow={false} receiveShadow={false} geometry={UNIT_BOX_GEOMETRY}>
      <meshBasicMaterial color={isSelected ? '#60a5fa' : '#7f1d1d'} opacity={0.8} transparent />
    </mesh>
    <lineSegments geometry={UNIT_BOX_EDGES_GEOMETRY}>
      <lineBasicMaterial color="#fca5a5" />
    </lineSegments>
  </group>
)

const ModelAsset: React.FC<{
  src: string
  fileName: string
  textures?: Record<string, string>
  instanceCacheKey?: string
  initialRotation?: [number, number, number]
  onBoundsChange?: (bounds: ModelBounds) => void
  emitModelCenteredEvent?: boolean
}> = ({
  src,
  fileName,
  textures,
  instanceCacheKey,
  initialRotation,
  onBoundsChange,
  emitModelCenteredEvent
}) => {
  const ext = fileName.toLowerCase().split('.').pop()

  switch (ext) {
    case 'glb':
    case 'gltf':
      return (
        <GLTFScene
          src={src}
          textures={textures}
          instanceCacheKey={instanceCacheKey}
          initialRotation={initialRotation}
          onBoundsChange={onBoundsChange}
          emitModelCenteredEvent={emitModelCenteredEvent ?? false}
        />
      )
    case 'fbx':
      return (
        <FBXScene
          src={src}
          textures={textures}
          instanceCacheKey={instanceCacheKey}
          initialRotation={initialRotation}
          onBoundsChange={onBoundsChange}
          emitModelCenteredEvent={emitModelCenteredEvent ?? false}
        />
      )
    case 'obj':
      return (
        <OBJScene
          src={src}
          textures={textures}
          instanceCacheKey={instanceCacheKey}
          initialRotation={initialRotation}
          onBoundsChange={onBoundsChange}
          emitModelCenteredEvent={emitModelCenteredEvent ?? false}
        />
      )
    case 'stl':
      return (
        <STLScene
          src={src}
          textures={textures}
          instanceCacheKey={instanceCacheKey}
          initialRotation={initialRotation}
          onBoundsChange={onBoundsChange}
          emitModelCenteredEvent={emitModelCenteredEvent ?? false}
        />
      )
    default:
      throw new Error(`Unsupported 3D model format: ${ext}`)
  }
}

export const Canvas3DViewerSurface = React.memo(function Canvas3DViewerSurface({
  item,
  qualityPreset,
  instanceCacheKey,
  renderKey,
  onError
}: Canvas3DViewerSurfaceProps) {
  return (
    <Canvas
      key={renderKey}
      camera={{ position: [0, 0, 3.2], fov: 40 }}
      gl={{
        alpha: true,
        antialias: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
        stencil: false
      }}
      dpr={qualityPreset.dpr}
      frameloop="demand"
      style={{ width: '100%', height: '100%', background: 'transparent' }}
    >
      <StageRendererSync />
      <ModelSceneCanvasSetup />
      <ContextRecovery />
      <ambientLight intensity={qualityPreset.ambientIntensity} />
      <hemisphereLight args={['#ffffff', '#b8c4d4', qualityPreset.hemisphereIntensity]} />
      {qualityPreset.directionalLights.map((light) => (
        <directionalLight
          key={`${light.position.join('-')}:${light.intensity}`}
          position={light.position}
          intensity={light.intensity}
        />
      ))}
      <ViewerModelRenderBoundary onError={onError}>
        <Suspense fallback={<LoadingModel isSelected={false} />}>
          <ModelAsset
            src={item.src}
            fileName={item.fileName}
            textures={item.textures}
            instanceCacheKey={instanceCacheKey}
            initialRotation={CANVAS_3D_STAGE_PREVIEW_MODEL_ROTATION}
            emitModelCenteredEvent
          />
        </Suspense>
      </ViewerModelRenderBoundary>
      <OrbitControls
        makeDefault
        enablePan
        enableZoom
        enableRotate
        enableDamping={false}
        minDistance={1}
        maxDistance={10}
        mouseButtons={{
          LEFT: THREE.MOUSE.ROTATE,
          MIDDLE: THREE.MOUSE.PAN,
          RIGHT: THREE.MOUSE.DOLLY
        }}
      />
      <AutoFitCamera />
    </Canvas>
  )
})

const StageDecoration: React.FC<{ lightingPreset: Canvas3DStageLightingPreset }> = ({
  lightingPreset
}) => {
  const lightingConfig = resolveCanvas3DStageLightingConfig(lightingPreset)

  return (
    <>
      <ambientLight intensity={lightingConfig.ambientIntensity} />
      <hemisphereLight
        args={['#ffffff', lightingConfig.hemisphereGround, lightingConfig.hemisphereIntensity]}
      />
      {lightingConfig.directionalLights.map((light) => (
        <directionalLight
          key={`${lightingPreset}:${light.position.join('-')}:${light.intensity}`}
          position={light.position}
          intensity={light.intensity}
        />
      ))}
    </>
  )
}

const StageRenderKick: React.FC<{
  loadStateVersion: number
  renderPumpFrames: number
}> = ({ loadStateVersion, renderPumpFrames }) => {
  const { invalidate } = useThree()

  useEffect(() => {
    let frameCount = 0
    let rafId = 0

    const pumpFrame = () => {
      invalidate()
      frameCount += 1
      if (frameCount < renderPumpFrames) {
        rafId = requestAnimationFrame(pumpFrame)
      }
    }

    pumpFrame()

    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [invalidate, loadStateVersion, renderPumpFrames])

  return null
}

const ContextRecovery: React.FC = () => {
  const { gl, scene, camera } = useThree()
  const recoveryTimerRef = useRef<number | null>(null)

  const scheduleRecovery = useCallback(
    (delay: number) => {
      if (recoveryTimerRef.current !== null) {
        window.clearTimeout(recoveryTimerRef.current)
      }

      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null
        clearCanvas3DStageRenderer(gl)
        gl.resetState()
        gl.render(scene, camera)
      }, delay)
    },
    [camera, gl, scene]
  )

  useEffect(() => {
    const canvas = gl.domElement

    const handleContextLost = (event: Event) => {
      event.preventDefault()
      console.warn('[3D] WebGL context lost')
    }

    const handleContextRestored = () => {
      scheduleRecovery(0)
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        scheduleRecovery(80)
      }
    }

    const handleFocus = () => {
      scheduleRecovery(120)
    }

    canvas.addEventListener('webglcontextlost', handleContextLost)
    canvas.addEventListener('webglcontextrestored', handleContextRestored)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)

    return () => {
      if (recoveryTimerRef.current !== null) {
        window.clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = null
      }
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      canvas.removeEventListener('webglcontextrestored', handleContextRestored)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [gl, scheduleRecovery])

  return null
}

const AutoFitCamera: React.FC = () => {
  const { scene, controls, camera, size } = useThree()

  useEffect(() => {
    const updateCamera = (event?: ModelSceneEventMap['model-centered']) => {
      const orbitControls = asOrbitControls(controls)
      if (!orbitControls || !(camera instanceof THREE.PerspectiveCamera)) return

      let center = event?.center?.clone()
      let radius = event?.radius ?? 0
      let objectSize = event?.size?.clone()

      if (!center || radius <= 0 || !objectSize) {
        const box = new THREE.Box3()
        scene.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            box.expandByObject(child)
          }
        })

        if (box.isEmpty()) return

        center = box.getCenter(new THREE.Vector3())
        objectSize = box.getSize(new THREE.Vector3())
        radius = objectSize.length() / 2
      }

      const fov = THREE.MathUtils.degToRad(camera.fov)
      const aspect = Math.max(size.width / Math.max(size.height, 1), 0.1)
      const halfHeight = Math.max(objectSize.y / 2, 0.001)
      const halfWidth = Math.max(objectSize.x / 2, 0.001)
      const fitHeightDistance = halfHeight / Math.tan(fov / 2)
      const fitWidthDistance = halfWidth / (Math.tan(fov / 2) * aspect)
      const distance = Math.max(fitHeightDistance, fitWidthDistance, radius * 1.2) * 1.02

      orbitControls.target.copy(center)
      camera.position.copy(
        center.clone().add(DEFAULT_CAMERA_DIRECTION.clone().multiplyScalar(distance))
      )
      camera.up.set(0, 1, 0)
      camera.near = Math.max(distance / 100, 0.01)
      camera.far = Math.max(distance * 20, 100)
      camera.updateProjectionMatrix()
      orbitControls.minDistance = Math.max(distance * 0.5, 0.1)
      orbitControls.maxDistance = Math.max(distance * 3, orbitControls.minDistance + 1)
      orbitControls.update()
    }

    const raf = requestAnimationFrame(() => updateCamera())
    const handler = (event: ModelSceneEventMap['model-centered']) =>
      requestAnimationFrame(() => updateCamera(event))
    const dispatcher = asModelSceneDispatcher(scene)
    dispatcher.addEventListener('model-centered', handler)

    return () => {
      cancelAnimationFrame(raf)
      dispatcher.removeEventListener('model-centered', handler)
    }
  }, [scene, controls, camera, size.height, size.width])

  return null
}

const MemoizedStageRenderKick = React.memo(
  StageRenderKick,
  areCanvas3DStageRenderKickPropsEqual
) as React.FC<{
  loadStateVersion: number
  renderPumpFrames: number
}>

export const resolveCanvas3DStagePreviewItem = (
  item: CanvasModel3DItem,
  preview: CanvasSyncDetail | null
): CanvasModel3DItem => {
  if (!preview) {
    return item
  }

  return {
    ...item,
    x: preview.x,
    y: preview.y,
    rotation: preview.rotation,
    scaleX: preview.scaleX,
    scaleY: preview.scaleY
  }
}

export type Canvas3DStageModelVisualMode =
  | 'cached-preview'
  | 'tiny-placeholder'
  | 'loading-placeholder'
  | 'deferred-placeholder'
  | 'live-model'

export const resolveCanvas3DStageModelVisualMode = ({
  shouldRenderPlaceholderOnly,
  isFullModelActivated,
  shouldMountFullModel,
  hasPreviewTexture
}: {
  shouldRenderPlaceholderOnly: boolean
  isFullModelActivated: boolean
  shouldMountFullModel: boolean
  hasPreviewTexture: boolean
}): Canvas3DStageModelVisualMode => {
  if (shouldRenderPlaceholderOnly) {
    return hasPreviewTexture ? 'cached-preview' : 'tiny-placeholder'
  }

  if (!isFullModelActivated) {
    return hasPreviewTexture ? 'cached-preview' : 'loading-placeholder'
  }

  if (!shouldMountFullModel) {
    return hasPreviewTexture ? 'cached-preview' : 'deferred-placeholder'
  }

  return 'live-model'
}

const ModelItem3D: React.FC<{
  item: CanvasModel3DItem
  preview: CanvasSyncDetail | null
  isSelected: boolean
  stageScale: number
  isFullModelActivated: boolean
  shouldMountFullModel: boolean
  sessionKey?: string
}> = ({
  item,
  preview,
  isSelected,
  stageScale,
  isFullModelActivated,
  shouldMountFullModel,
  sessionKey
}) => {
  const renderItem = useMemo(() => resolveCanvas3DStagePreviewItem(item, preview), [item, preview])
  const resolvedSessionKey = sessionKey?.trim() || DEFAULT_CANVAS_MODEL3D_SESSION_KEY
  const instanceCacheKey = useMemo(
    () =>
      getSceneInstanceCloneCacheKey({
        sessionKey: resolvedSessionKey,
        src: item.src,
        fileName: item.fileName,
        itemId: item.id,
        textures: item.textures
      }),
    [item.fileName, item.id, item.src, item.textures, resolvedSessionKey]
  )
  const [modelBounds, setModelBounds] = useState<ModelBounds | null>(() =>
    readCanvas3DStageModelBoundsCache(instanceCacheKey)
  )
  const { canvasWidth, canvasHeight, displayWidth, displayHeight } = useMemo(
    () => getCanvas3DStageItemDisplayMetrics(renderItem, stageScale),
    [renderItem, stageScale]
  )
  const shouldRenderPlaceholderOnly =
    displayWidth < MIN_MODEL_RENDER_SIZE_PX || displayHeight < MIN_MODEL_RENDER_SIZE_PX
  const shouldUsePreviewTexture =
    shouldRenderPlaceholderOnly || !isFullModelActivated || !shouldMountFullModel
  const previewFootprint = useMemo(
    () =>
      shouldUsePreviewTexture
        ? getProjectedFootprint(
            modelBounds?.size ?? DEFAULT_MODEL_BOUNDS_SIZE,
            CANVAS_3D_STAGE_PREVIEW_MODEL_ROTATION
          )
        : null,
    [modelBounds, shouldUsePreviewTexture]
  )
  const previewTextureKey = useMemo(
    () =>
      modelBounds
        ? getCanvas3DStagePreviewTextureKey({
            instanceCacheKey,
            fileName: renderItem.fileName,
            bounds: modelBounds
          })
        : null,
    [instanceCacheKey, modelBounds, renderItem.fileName]
  )
  const shouldRequestPreviewTexture = Boolean(
    previewTextureKey && modelBounds && (isFullModelActivated || shouldUsePreviewTexture)
  )
  const [previewTexture, setPreviewTexture] = useState<THREE.Texture | null>(() =>
    readCanvas3DStagePreviewTexture(previewTextureKey)
  )
  const visualMode = resolveCanvas3DStageModelVisualMode({
    shouldRenderPlaceholderOnly,
    isFullModelActivated,
    shouldMountFullModel,
    hasPreviewTexture: Boolean(previewTexture)
  })
  const fitScale = useMemo(
    () =>
      getPreviewFitScale({
        canvasWidth,
        canvasHeight,
        bounds: modelBounds
      }),
    [canvasHeight, canvasWidth, modelBounds]
  )
  const depthScale = Math.max(fitScale, 8)
  const centerX = renderItem.x + canvasWidth / 2
  const centerY = -(renderItem.y + canvasHeight / 2)
  useEffect(() => {
    const cachedBounds = readCanvas3DStageModelBoundsCache(instanceCacheKey)
    setModelBounds((previousBounds) => {
      if (!cachedBounds) {
        return previousBounds ? null : previousBounds
      }

      return areBoundsSimilar(previousBounds, cachedBounds) ? previousBounds : cachedBounds
    })
  }, [instanceCacheKey])
  useEffect(() => {
    if (!previewTextureKey || !shouldRequestPreviewTexture) {
      setPreviewTexture(null)
      return
    }

    const cachedTexture = readCanvas3DStagePreviewTexture(previewTextureKey)
    if (cachedTexture) {
      setPreviewTexture((previousTexture) =>
        previousTexture === cachedTexture ? previousTexture : cachedTexture
      )
      return
    }

    setPreviewTexture(null)
    let cancelled = false

    void getOrCreateCanvas3DStagePreviewTexture({
      cacheKey: previewTextureKey,
      instanceCacheKey
    }).then((nextTexture) => {
      if (cancelled || !nextTexture) {
        return
      }

      setPreviewTexture((previousTexture) =>
        previousTexture === nextTexture ? previousTexture : nextTexture
      )
    })

    return () => {
      cancelled = true
    }
  }, [instanceCacheKey, previewTextureKey, shouldRequestPreviewTexture])
  const handleBoundsChange = useCallback(
    (nextBounds: ModelBounds) => {
      writeCanvas3DStageModelBoundsCache(instanceCacheKey, nextBounds)
      setModelBounds((prevBounds) =>
        areBoundsSimilar(prevBounds, nextBounds) ? prevBounds : cloneBounds(nextBounds)
      )
    },
    [instanceCacheKey]
  )
  const showBackdrop = shouldMountFullModel || isSelected

  return (
    <group
      position={[centerX, centerY, 0]}
      rotation={[0, 0, -(renderItem.rotation || 0) * DEG_TO_RAD]}
    >
      {showBackdrop ? (
        <>
          <mesh
            position={[0, 0, -depthScale * 1.45]}
            renderOrder={-2}
            geometry={UNIT_PLANE_GEOMETRY}
            scale={[canvasWidth * 1.05, canvasHeight * 1.05, 1]}
          >
            <meshBasicMaterial
              color={isSelected ? '#2563eb' : '#cbd5e1'}
              opacity={isSelected ? 0.18 : 0.08}
              transparent
              depthWrite={false}
            />
          </mesh>
          <mesh
            position={[0, Math.max(canvasHeight * 0.1, 10), -depthScale * 1.1]}
            renderOrder={-1}
            geometry={UNIT_PLANE_GEOMETRY}
            scale={[canvasWidth * 0.82, canvasHeight * 0.28, 1]}
          >
            <meshBasicMaterial color="#ffffff" opacity={0.05} transparent depthWrite={false} />
          </mesh>
        </>
      ) : null}
      <group
        scale={[fitScale, fitScale, fitScale]}
        rotation={
          visualMode === 'cached-preview' ? undefined : CANVAS_3D_STAGE_PREVIEW_MODEL_ROTATION
        }
      >
        {visualMode === 'cached-preview' && previewTexture ? (
          <CachedPreviewModel
            texture={previewTexture}
            width={previewFootprint?.width ?? 1}
            height={previewFootprint?.height ?? 1}
            isSelected={isSelected}
          />
        ) : visualMode === 'tiny-placeholder' ? (
          <TinyModelPlaceholder isSelected={isSelected} />
        ) : visualMode === 'loading-placeholder' ? (
          <LoadingModel isSelected={isSelected} />
        ) : visualMode === 'deferred-placeholder' ? (
          <DeferredModelPlaceholder isSelected={isSelected} />
        ) : (
          <ModelRenderBoundary isSelected={isSelected}>
            <Suspense fallback={<LoadingModel isSelected={isSelected} />}>
              <ModelAsset
                src={item.src}
                fileName={item.fileName}
                textures={item.textures}
                instanceCacheKey={instanceCacheKey}
                onBoundsChange={handleBoundsChange}
              />
            </Suspense>
          </ModelRenderBoundary>
        )}
      </group>
    </group>
  )
}

const MemoizedModelItem3D = React.memo(
  ModelItem3D,
  areCanvas3DStageModelItemRenderStatesEqual
) as React.FC<Canvas3DStageModelItemRenderState>

const Canvas3DStage: React.FC<Canvas3DStageProps> = ({
  items,
  selectedIds,
  stagePos,
  stageScale,
  stageSize,
  sessionKey,
  isViewportInteracting = false,
  onViewportSyncReady
}) => {
  const [previewById, setPreviewById] = useState<Record<string, CanvasSyncDetail | null>>({})
  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const freezeFrameCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [freezeFrameSnapshot, setFreezeFrameSnapshot] =
    useState<Canvas3DStageFreezeFrameSnapshot | null>(null)
  const resolvedSessionKey = sessionKey?.trim() || DEFAULT_CANVAS_MODEL3D_SESSION_KEY
  const registerImperativeViewportSync = useCallback(
    (sync: Canvas3DStageViewportSync | null) => {
      onViewportSyncReady?.(sync)
    },
    [onViewportSyncReady]
  )
  const stagePosX = stagePos.x
  const stagePosY = stagePos.y
  const stageWidth = stageSize.width
  const stageHeight = stageSize.height
  const viewportState = useMemo(
    () =>
      createCanvas3DStageViewportState({
        stagePos: { x: stagePosX, y: stagePosY },
        stageScale,
        stageSize: { width: stageWidth, height: stageHeight }
      }),
    [stagePosX, stagePosY, stageScale, stageWidth, stageHeight]
  )
  useEffect(() => {
    const itemIdSet = new Set(items.map((item) => item.id))

    setPreviewById((previous) => {
      let changed = false
      const next: Record<string, CanvasSyncDetail | null> = {}
      for (const [itemId, preview] of Object.entries(previous)) {
        if (itemIdSet.has(itemId)) {
          next[itemId] = preview
        } else {
          changed = true
        }
      }

      return changed ? next : previous
    })

    const cleanups = items.map((item) => {
      const handleCanvasSync = (event: Event) => {
        const detail = (event as CustomEvent<CanvasSyncDetail>).detail
        if (!detail) {
          return
        }

        setPreviewById((previous) => {
          const currentPreview = previous[item.id]
          if (
            currentPreview &&
            currentPreview.x === detail.x &&
            currentPreview.y === detail.y &&
            currentPreview.rotation === detail.rotation &&
            currentPreview.scaleX === detail.scaleX &&
            currentPreview.scaleY === detail.scaleY
          ) {
            return previous
          }

          return {
            ...previous,
            [item.id]: detail
          }
        })
      }
      const handleCanvasReset = () => {
        setPreviewById((previous) => {
          if (!(item.id in previous)) {
            return previous
          }

          const next = { ...previous }
          delete next[item.id]
          return next
        })
      }

      window.addEventListener(`canvas-sync-${item.id}`, handleCanvasSync)
      window.addEventListener(`canvas-reset-${item.id}`, handleCanvasReset)
      return () => {
        window.removeEventListener(`canvas-sync-${item.id}`, handleCanvasSync)
        window.removeEventListener(`canvas-reset-${item.id}`, handleCanvasReset)
      }
    })

    return () => {
      cleanups.forEach((dispose) => dispose())
    }
  }, [items])

  const { visibleItemIds, viewportCulledCount } = useMemo(
    () =>
      resolveCanvas3DStageViewportSummary({
        items,
        selectedIds,
        stagePos,
        stageScale,
        stageSize,
        skipViewportCulling: isViewportInteracting
      }),
    [isViewportInteracting, items, selectedIds, stagePos, stageScale, stageSize]
  )
  const viewportVisibleItems = useMemo(
    () => items.filter((item) => visibleItemIds.has(item.id)),
    [items, visibleItemIds]
  )
  const { prioritizedLoadIds, prioritizedLoadItems, immediateLoadLimit, placeholderOnlyIds } =
    useMemo(
      () => resolveCanvas3DStageLoadQueue({ items: viewportVisibleItems, selectedIds, stageScale }),
      [viewportVisibleItems, selectedIds, stageScale]
    )
  const [activatedItemIds, setActivatedItemIds] = useState<Set<string>>(() => new Set())
  const [isViewportSettling, setIsViewportSettling] = useState(false)
  const isViewportMoving = isViewportInteracting || isViewportSettling
  const previousViewportRef = useRef<{
    stagePosX: number
    stagePosY: number
    stageScale: number
  } | null>(null)

  useEffect(() => {
    setActivatedItemIds((previousActivatedIds) => {
      const nextActivatedIds = resolveCanvas3DStageActivatedIds({
        prioritizedLoadIds,
        previousActivatedIds,
        immediateLoadLimit
      })

      return areCanvas3DStageIdSetsEqual(previousActivatedIds, nextActivatedIds)
        ? previousActivatedIds
        : nextActivatedIds
    })
  }, [immediateLoadLimit, prioritizedLoadIds])

  useEffect(() => {
    const previousViewport = previousViewportRef.current
    previousViewportRef.current = {
      stagePosX: stagePos.x,
      stagePosY: stagePos.y,
      stageScale
    }

    if (
      previousViewport &&
      previousViewport.stagePosX === stagePos.x &&
      previousViewport.stagePosY === stagePos.y &&
      previousViewport.stageScale === stageScale
    ) {
      return
    }

    setIsViewportSettling(true)
    const timerId = window.setTimeout(() => {
      setIsViewportSettling(false)
    }, CANVAS_3D_STAGE_VIEWPORT_SETTLE_MS)

    return () => {
      window.clearTimeout(timerId)
    }
  }, [stagePos.x, stagePos.y, stageScale])

  useEffect(() => {
    if (isViewportMoving) return

    const batchPolicy = resolveCanvas3DStageActivationBatchPolicy({
      prioritizedItems: prioritizedLoadItems,
      activatedIds: activatedItemIds,
      defaultDelayMs: MODEL_LOAD_BATCH_DELAY_MS
    })
    const nextBatch = resolveCanvas3DStageNextActivationBatch({
      prioritizedLoadIds,
      activatedIds: activatedItemIds,
      batchSize: batchPolicy.batchSize
    })
    if (nextBatch.length === 0) return

    const timerId = window.setTimeout(() => {
      React.startTransition(() => {
        setActivatedItemIds((previousActivatedIds) => {
          const nextActivatedIds = new Set(previousActivatedIds)
          for (const itemId of nextBatch) {
            nextActivatedIds.add(itemId)
          }

          return areCanvas3DStageIdSetsEqual(previousActivatedIds, nextActivatedIds)
            ? previousActivatedIds
            : nextActivatedIds
        })
      })
    }, batchPolicy.delayMs)

    return () => {
      window.clearTimeout(timerId)
    }
  }, [activatedItemIds, isViewportMoving, prioritizedLoadIds, prioritizedLoadItems])

  const freezeFrameTransform = useMemo(
    () =>
      freezeFrameSnapshot
        ? resolveCanvas3DStageFreezeFrameTransform({
            snapshotViewport: freezeFrameSnapshot.viewport,
            currentViewport: viewportState
          })
        : null,
    [freezeFrameSnapshot, viewportState]
  )
  const shouldFreezeViewport =
    ENABLE_CANVAS_3D_STAGE_VIEWPORT_FREEZE && isViewportMoving && Boolean(freezeFrameTransform)
  const liveViewportMoving = isViewportMoving && !shouldFreezeViewport
  const adaptiveDpr = useMemo(
    () =>
      resolveCanvas3DStageDpr({
        itemCount: viewportVisibleItems.length,
        activatedItemCount: activatedItemIds.size,
        isViewportMoving: liveViewportMoving
      }),
    [activatedItemIds.size, liveViewportMoving, viewportVisibleItems.length]
  )
  const mountedItemIds = useMemo(
    () =>
      resolveCanvas3DStageMountedIds({
        activatedIds: activatedItemIds,
        prioritizedLoadIds,
        isViewportMoving: liveViewportMoving
      }),
    [activatedItemIds, liveViewportMoving, prioritizedLoadIds]
  )
  const pendingActivationCount = useMemo(
    () => prioritizedLoadIds.filter((itemId) => !activatedItemIds.has(itemId)).length,
    [activatedItemIds, prioritizedLoadIds]
  )
  const renderPumpFrames = useMemo(
    () =>
      resolveCanvas3DStageRenderPumpFrames({
        isViewportMoving: liveViewportMoving,
        pendingActivationCount,
        mountedItemCount: mountedItemIds.size
      }),
    [liveViewportMoving, mountedItemIds.size, pendingActivationCount]
  )
  const stageFrameloop = useMemo(
    () =>
      resolveCanvas3DStageFrameloop({
        isViewportMoving: liveViewportMoving
      }),
    [liveViewportMoving]
  )
  const lightingPreset = useMemo(
    () =>
      resolveCanvas3DStageLightingPreset({
        activatedItemCount: activatedItemIds.size
      }),
    [activatedItemIds.size]
  )
  const shouldRenderLighting = useMemo(
    () =>
      shouldCanvas3DStageRenderLighting({
        mountedItemCount: mountedItemIds.size
      }),
    [mountedItemIds.size]
  )
  const captureFreezeFrameSnapshot = useCallback((nextViewport: Canvas3DStageViewportState) => {
    const sourceCanvas = stageCanvasRef.current
    if (!sourceCanvas || sourceCanvas.width <= 0 || sourceCanvas.height <= 0) {
      return
    }

    const snapshotCanvas = document.createElement('canvas')
    snapshotCanvas.width = sourceCanvas.width
    snapshotCanvas.height = sourceCanvas.height
    const context = snapshotCanvas.getContext('2d')
    if (!context) {
      return
    }

    try {
      context.clearRect(0, 0, snapshotCanvas.width, snapshotCanvas.height)
      context.drawImage(sourceCanvas, 0, 0)
      if (!hasCanvas3DStageFreezeFrameContent(snapshotCanvas, context)) {
        setFreezeFrameSnapshot(null)
        return
      }
      setFreezeFrameSnapshot({
        canvas: snapshotCanvas,
        viewport: createCanvas3DStageViewportState(nextViewport)
      })
    } catch (error) {
      console.warn('[3D] Failed to capture stage freeze frame', error)
    }
  }, [])

  useEffect(() => {
    if (!ENABLE_CANVAS_3D_STAGE_VIEWPORT_FREEZE) {
      return
    }

    if (items.length === 0 || stageSize.width <= 0 || stageSize.height <= 0) {
      setFreezeFrameSnapshot(null)
    }
  }, [items.length, stageSize.height, stageSize.width])

  useEffect(() => {
    if (!ENABLE_CANVAS_3D_STAGE_VIEWPORT_FREEZE) {
      return
    }

    if (isViewportMoving || items.length === 0 || stageSize.width <= 0 || stageSize.height <= 0) {
      return
    }

    let cancelled = false
    const rafIds: number[] = []
    let remainingFrames = Math.max(renderPumpFrames, 1) + 1

    const scheduleCapture = () => {
      const rafId = window.requestAnimationFrame(() => {
        if (cancelled) {
          return
        }

        if (remainingFrames > 0) {
          remainingFrames -= 1
          scheduleCapture()
          return
        }

        captureFreezeFrameSnapshot(viewportState)
      })

      rafIds.push(rafId)
    }

    scheduleCapture()

    return () => {
      cancelled = true
      rafIds.forEach((rafId) => window.cancelAnimationFrame(rafId))
    }
  }, [
    captureFreezeFrameSnapshot,
    isViewportMoving,
    items.length,
    renderPumpFrames,
    stageSize.height,
    stageSize.width,
    viewportState,
    viewportVisibleItems.length,
    activatedItemIds.size,
    mountedItemIds.size,
    pendingActivationCount
  ])

  useEffect(() => {
    if (!ENABLE_CANVAS_3D_STAGE_VIEWPORT_FREEZE) {
      return
    }

    if (!freezeFrameSnapshot || !freezeFrameCanvasRef.current) {
      return
    }

    const overlayCanvas = freezeFrameCanvasRef.current
    overlayCanvas.width = freezeFrameSnapshot.canvas.width
    overlayCanvas.height = freezeFrameSnapshot.canvas.height

    const context = overlayCanvas.getContext('2d')
    if (!context) {
      return
    }

    context.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
    context.drawImage(freezeFrameSnapshot.canvas, 0, 0)
  }, [freezeFrameSnapshot])

  if (items.length === 0 || stageSize.width <= 0 || stageSize.height <= 0) return null
  const mountedVisibleItemCount = viewportVisibleItems.filter((item) =>
    mountedItemIds.has(item.id)
  ).length
  const fullModelMountedCount = viewportVisibleItems.filter(
    (item) =>
      mountedItemIds.has(item.id) &&
      activatedItemIds.has(item.id) &&
      !placeholderOnlyIds.has(item.id)
  ).length
  const placeholderOnlyCount = viewportVisibleItems.filter(
    (item) => placeholderOnlyIds.has(item.id) || !mountedItemIds.has(item.id)
  ).length

  return (
    <div
      data-project-canvas-3d-total-count={items.length}
      data-project-canvas-3d-visible-count={viewportVisibleItems.length}
      data-project-canvas-3d-viewport-culled-count={viewportCulledCount}
      data-project-canvas-3d-activated-count={activatedItemIds.size}
      data-project-canvas-3d-mounted-count={mountedVisibleItemCount}
      data-project-canvas-3d-full-model-count={fullModelMountedCount}
      data-project-canvas-3d-placeholder-count={placeholderOnlyCount}
      data-project-canvas-3d-queue-depth={pendingActivationCount}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        background: 'transparent'
      }}
    >
      {shouldFreezeViewport && freezeFrameSnapshot && freezeFrameTransform ? (
        <canvas
          ref={freezeFrameCanvasRef}
          width={freezeFrameSnapshot.canvas.width}
          height={freezeFrameSnapshot.canvas.height}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: freezeFrameSnapshot.viewport.stageSize.width,
            height: freezeFrameSnapshot.viewport.stageSize.height,
            pointerEvents: 'none',
            background: 'transparent',
            transformOrigin: '0 0',
            transform: freezeFrameTransform.transform
          }}
        />
      ) : null}
      <Canvas
        onCreated={({ gl }) => {
          stageCanvasRef.current = gl.domElement
        }}
        orthographic
        frameloop={stageFrameloop}
        dpr={adaptiveDpr}
        gl={CANVAS_3D_STAGE_GL_OPTIONS}
        camera={{
          position: [0, 0, 1000],
          zoom: Math.max(stageScale, PROJECT_CANVAS_MIN_STAGE_SCALE),
          near: 0.1,
          far: 5000
        }}
        style={{
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          background: 'transparent',
          visibility: shouldFreezeViewport ? 'hidden' : 'visible'
        }}
      >
        <StageRendererSync />
        {!shouldFreezeViewport ? (
          <StageImperativeViewportSync
            stageSize={stageSize}
            onRegisterSync={registerImperativeViewportSync}
          />
        ) : null}
        <ModelSceneCanvasSetup enableEnvironment={shouldRenderLighting} />
        {!shouldFreezeViewport ? (
          <StageCameraSync stagePos={stagePos} stageScale={stageScale} stageSize={stageSize} />
        ) : null}
        {!shouldFreezeViewport ? (
          <MemoizedStageRenderKick
            loadStateVersion={mountedItemIds.size}
            renderPumpFrames={renderPumpFrames}
          />
        ) : null}
        {shouldRenderLighting ? <StageDecoration lightingPreset={lightingPreset} /> : null}
        {viewportVisibleItems.map((item) => (
          <MemoizedModelItem3D
            key={item.id}
            item={item}
            preview={previewById[item.id] ?? null}
            isSelected={selectedIds.has(item.id)}
            stageScale={stageScale}
            isFullModelActivated={activatedItemIds.has(item.id)}
            shouldMountFullModel={mountedItemIds.has(item.id)}
            sessionKey={resolvedSessionKey}
          />
        ))}
      </Canvas>
    </div>
  )
}

export default React.memo(Canvas3DStage, areCanvas3DStagePropsEqual)
