import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

import { QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'
import { AGENT_MODEL3D_DRAG_MIME } from '../chatDragData'
import {
  isHy3dCosModelUrlExpiringSoon,
  parseHy3dCosModelMetaFromUrl,
  resolveHy3dPreviewCameraFrame
} from './ModelDropZone'
import ModelDropZone from './ModelDropZone'

const notifyInfoMock = vi.fn()
const notifySuccessMock = vi.fn()
const notifyWarningMock = vi.fn()
const closeMessageMock = vi.fn()
const uploadHy3DModelMock = vi.fn()
const signHy3DModelMock = vi.fn()
const showOpenDialogMock = vi.fn()
const fileToDataUrlMock = vi.fn()

vi.mock('@react-three/fiber', () => ({
  Canvas: () => <div data-testid="mock-canvas" />,
  useThree: vi.fn()
}))

vi.mock('@react-three/drei', () => ({
  OrbitControls: () => null
}))

vi.mock('../../ProjectCanvasPage/components/modelLoaders/GLTFScene', () => ({
  default: () => <div data-testid="mock-gltf-scene" />
}))

vi.mock('../../ProjectCanvasPage/components/modelLoaders/FBXScene', () => ({
  default: () => <div data-testid="mock-fbx-scene" />
}))

vi.mock('../../ProjectCanvasPage/components/modelLoaders/OBJScene', () => ({
  default: () => <div data-testid="mock-obj-scene" />
}))

vi.mock('../../ProjectCanvasPage/components/modelLoaders/STLScene', () => ({
  default: () => <div data-testid="mock-stl-scene" />
}))

vi.mock('../../ProjectCanvasPage/components/modelLoaders/shared', () => ({
  ModelSceneCanvasSetup: () => null
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifyInfo: notifyInfoMock,
    notifySuccess: notifySuccessMock,
    notifyWarning: notifyWarningMock,
    closeMessage: closeMessageMock
  })
}))

vi.mock('@renderer/utils/fileUtils', () => ({
  fileToDataUrl: (...args: unknown[]) => fileToDataUrlMock(...args)
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcLLMProxy: {
      uploadHy3DModel: uploadHy3DModelMock,
      signHy3DModel: signHy3DModelMock
    },
    svcDialog: {
      showOpenDialog: showOpenDialogMock
    }
  })
}))

const createDataTransfer = (data: Record<string, string>, files: File[] = []) =>
  ({
    files,
    items: [],
    getData: (key: string) => data[key] || ''
  }) as unknown as DataTransfer

describe('Hunyuan3D model drop zone', () => {
  beforeEach(() => {
    notifyInfoMock.mockReset()
    notifySuccessMock.mockReset()
    notifyWarningMock.mockReset()
    closeMessageMock.mockReset()
    uploadHy3DModelMock.mockReset()
    signHy3DModelMock.mockReset()
    showOpenDialogMock.mockReset()
    fileToDataUrlMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('parses Hunyuan COS model urls into resumable storage metadata', () => {
    const meta = parseHy3dCosModelMetaFromUrl(
      'https://hunyuan-prod-1258344699.cos.ap-guangzhou.tencentcos.cn/3d/1314265479/demo.fbx?q-sign-time=1776515168%3B1776518768&q-key-time=1776515168%3B1776518768',
      'demo.fbx'
    )

    expect(meta).toEqual({
      sourceFileName: 'demo.fbx',
      storageKey: '3d/1314265479/demo.fbx',
      storageBucket: 'hunyuan-prod-1258344699',
      storageRegion: 'ap-guangzhou',
      signedUrlExpiresAt: '2026-04-18T13:26:08.000Z',
      expiresAtMs: 1776518768000
    })
    expect(isHy3dCosModelUrlExpiringSoon(meta, 1776521598000)).toBe(true)
  })

  it('collapses the URL input in url-only mode when toggled closed', () => {
    render(<ModelDropZone value="" onChange={vi.fn()} label="Model URL" urlOnly />)

    expect(screen.getByPlaceholderText('https://example.com/model.glb')).toBeTruthy()

    fireEvent.click(screen.getByTestId('hy3d-model-url-toggle'))

    expect(screen.queryByPlaceholderText('https://example.com/model.glb')).toBeNull()
    expect(screen.getByTestId('hy3d-model-url-toggle')).toBeTruthy()
  })

  it('uploads dropped internal canvas model payloads backed by blob urls', async () => {
    const onChange = vi.fn()
    const onMetaChange = vi.fn()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['glb-bytes'], { type: 'model/gltf-binary' }))
    })

    vi.stubGlobal('fetch', fetchMock)
    fileToDataUrlMock.mockResolvedValue('data:model/gltf-binary;base64,QUJD')
    uploadHy3DModelMock.mockResolvedValue({
      fileName: 'pineapple.glb',
      url: 'https://example.com/uploaded.glb',
      key: 'models/pineapple.glb',
      bucket: 'demo-bucket',
      region: 'ap-guangzhou',
      expiresAt: '2099-01-01T00:00:00.000Z'
    })

    render(
      <ModelDropZone
        value=""
        onChange={onChange}
        onMetaChange={onMetaChange}
        label="Model URL"
        urlOnly
        enableLocalUpload
      />
    )

    fireEvent.drop(screen.getByTestId('hy3d-model-drop-zone'), {
      dataTransfer: createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          itemTypes: ['model3d'],
          attachments: [
            {
              type: 'model3d',
              url: 'blob:canvas-model',
              fileName: 'pineapple.glb',
              mimeType: 'model/gltf-binary'
            }
          ]
        })
      })
    })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('blob:canvas-model')
      expect(fileToDataUrlMock).toHaveBeenCalled()
      expect(uploadHy3DModelMock).toHaveBeenCalledWith({
        fileName: 'pineapple.glb',
        fileDataBase64: 'QUJD'
      })
      expect(onChange).toHaveBeenCalledWith('https://example.com/uploaded.glb')
    })

    expect(onMetaChange).toHaveBeenLastCalledWith({
      sourceFileName: 'pineapple.glb',
      storageKey: 'models/pineapple.glb',
      storageBucket: 'demo-bucket',
      storageRegion: 'ap-guangzhou',
      signedUrlExpiresAt: '2099-01-01T00:00:00.000Z'
    })
  })

  it('accepts replacement drops on the preview area when a model is already loaded', async () => {
    const onChange = vi.fn()
    const onMetaChange = vi.fn()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['glb-bytes'], { type: 'model/gltf-binary' }))
    })

    vi.stubGlobal('fetch', fetchMock)
    fileToDataUrlMock.mockResolvedValue('data:model/gltf-binary;base64,QUJD')
    uploadHy3DModelMock.mockResolvedValue({
      fileName: 'replacement.glb',
      url: 'https://example.com/replacement.glb',
      key: 'models/replacement.glb',
      bucket: 'demo-bucket',
      region: 'ap-guangzhou',
      expiresAt: '2099-01-01T00:00:00.000Z'
    })

    render(
      <ModelDropZone
        value="https://example.com/current.glb"
        onChange={onChange}
        onMetaChange={onMetaChange}
        fileName="current.glb"
        label="Model URL"
        urlOnly
        enableLocalUpload
      />
    )

    fireEvent.drop(screen.getByTestId('hy3d-model-preview-drop-zone'), {
      dataTransfer: createDataTransfer({
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          itemTypes: ['model3d'],
          attachments: [
            {
              type: 'model3d',
              url: 'blob:replacement-model',
              fileName: 'replacement.glb',
              mimeType: 'model/gltf-binary'
            }
          ]
        })
      })
    })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('blob:replacement-model')
      expect(uploadHy3DModelMock).toHaveBeenCalledWith({
        fileName: 'replacement.glb',
        fileDataBase64: 'QUJD'
      })
      expect(onChange).toHaveBeenCalledWith('https://example.com/replacement.glb')
    })

    expect(onMetaChange).toHaveBeenLastCalledWith({
      sourceFileName: 'replacement.glb',
      storageKey: 'models/replacement.glb',
      storageBucket: 'demo-bucket',
      storageRegion: 'ap-guangzhou',
      signedUrlExpiresAt: '2099-01-01T00:00:00.000Z'
    })
  })

  it('accepts dropped model urls from agent cards without re-uploading them', async () => {
    const onChange = vi.fn()
    const onMetaChange = vi.fn()

    render(
      <ModelDropZone
        value=""
        onChange={onChange}
        onMetaChange={onMetaChange}
        label="Model URL"
        urlOnly
        enableLocalUpload
      />
    )

    fireEvent.drop(screen.getByTestId('hy3d-model-drop-zone'), {
      dataTransfer: createDataTransfer({
        [AGENT_MODEL3D_DRAG_MIME]: 'https://example.com/assets/pineapple.glb?signature=demo'
      })
    })

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(
        'https://example.com/assets/pineapple.glb?signature=demo'
      )
    })

    expect(uploadHy3DModelMock).not.toHaveBeenCalled()
    expect(onMetaChange).toHaveBeenLastCalledWith({
      sourceFileName: 'pineapple.glb',
      storageKey: '',
      storageBucket: '',
      storageRegion: '',
      signedUrlExpiresAt: ''
    })
  })

  it('does not try to re-sign remote model urls without stored upload metadata', async () => {
    render(
      <ModelDropZone
        value="https://hunyuan-prod-1258344699.cos.ap-guangzhou.tencentcos.cn/3d/1314265479/demo.fbx?q-sign-time=1000%3B1010&q-key-time=1000%3B1010"
        onChange={vi.fn()}
        onMetaChange={vi.fn()}
        fileName="demo.fbx"
        label="Model URL"
        urlOnly
        enableLocalUpload
      />
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(signHy3DModelMock).not.toHaveBeenCalled()
  })

  it('refreshes expired Hunyuan COS model urls before previewing them', async () => {
    const onChange = vi.fn()
    const onMetaChange = vi.fn()

    signHy3DModelMock.mockResolvedValue({
      url: 'https://hunyuan-prod-1258344699.cos.ap-guangzhou.tencentcos.cn/3d/1314265479/demo.fbx?q-sign-time=1776521600%3B1776525200',
      expiresAt: '2026-04-18T15:13:20.000Z'
    })

    render(
      <ModelDropZone
        value="https://hunyuan-prod-1258344699.cos.ap-guangzhou.tencentcos.cn/3d/1314265479/demo.fbx?q-sign-time=1000%3B1010&q-key-time=1000%3B1010"
        onChange={onChange}
        onMetaChange={onMetaChange}
        fileName="demo.fbx"
        storageMeta={{
          sourceFileName: 'demo.fbx',
          storageKey: '3d/1314265479/demo.fbx',
          storageBucket: 'hunyuan-prod-1258344699',
          storageRegion: 'ap-guangzhou',
          signedUrlExpiresAt: '1970-01-01T00:16:50.000Z'
        }}
        label="Model URL"
        urlOnly
        enableLocalUpload
      />
    )

    await waitFor(() => {
      expect(signHy3DModelMock).toHaveBeenCalledWith({
        key: '3d/1314265479/demo.fbx',
        bucket: 'hunyuan-prod-1258344699',
        region: 'ap-guangzhou'
      })
    })

    expect(onChange).toHaveBeenCalledWith(
      'https://hunyuan-prod-1258344699.cos.ap-guangzhou.tencentcos.cn/3d/1314265479/demo.fbx?q-sign-time=1776521600%3B1776525200'
    )
    expect(onMetaChange).toHaveBeenLastCalledWith({
      sourceFileName: 'demo.fbx',
      storageKey: '3d/1314265479/demo.fbx',
      storageBucket: 'hunyuan-prod-1258344699',
      storageRegion: 'ap-guangzhou',
      signedUrlExpiresAt: '2026-04-18T15:13:20.000Z'
    })
  })

  it('computes a wide enough preview camera frame for tall FBX bounds', () => {
    const frame = resolveHy3dPreviewCameraFrame({
      center: new THREE.Vector3(4, 2, -3),
      size: new THREE.Vector3(12, 24, 10),
      radius: 14.45683229480096,
      cameraFovDeg: 40,
      viewportWidth: 240,
      viewportHeight: 180
    })

    expect(frame.target.toArray()).toEqual([4, 2, -3])
    expect(frame.position.length()).toBeGreaterThan(30)
    expect(frame.near).toBeGreaterThan(0.3)
    expect(frame.far).toBeGreaterThan(600)
    expect(frame.minDistance).toBeGreaterThan(15)
    expect(frame.maxDistance).toBeGreaterThan(90)
  })
})
