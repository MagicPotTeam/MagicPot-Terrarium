import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import Model3DViewerDialog, { resolveModel3DViewerStageBackgroundSx } from './Model3DViewerDialog'
import { resolveModel3DViewerQualityPreset } from './model3DViewerQualityPreset'
import type { CanvasModel3DItem } from '../types'
import {
  DEFAULT_CANVAS_MODEL3D_SESSION_KEY,
  getSceneInstanceCloneCacheKey
} from './modelLoaders/sceneInstanceCloneCacheKey'

vi.mock('./Canvas3DStage', async () => {
  const React = await import('react')

  return {
    Canvas3DViewerSurface: ({
      qualityPreset,
      renderKey,
      instanceCacheKey
    }: {
      qualityPreset: { dpr: [number, number] }
      renderKey?: string
      instanceCacheKey?: string
    }) =>
      React.createElement('div', {
        'data-testid': 'canvas3d-viewer-surface',
        'data-dpr': JSON.stringify(qualityPreset.dpr),
        'data-render-key': renderKey ?? '',
        'data-instance-cache-key': instanceCacheKey ?? ''
      })
  }
})

const baseItem: CanvasModel3DItem = {
  id: 'model-1',
  type: 'model3d',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  zIndex: 1,
  locked: false,
  src: 'blob:mock-model',
  fileName: 'sample.glb'
}

function renderDialog(item: CanvasModel3DItem = baseItem, sessionKey?: string) {
  return render(
    <Model3DViewerDialog
      open
      item={item}
      {...(sessionKey ? { sessionKey } : {})}
      onClose={vi.fn()}
      onDownload={vi.fn()}
      onImportTextures={vi.fn()}
    />
  )
}

describe('resolveModel3DViewerQualityPreset', () => {
  it('lowers the render budget for heavy viewer models', () => {
    expect(resolveModel3DViewerQualityPreset({ fileName: 'scene.fbx', textureCount: 6 })).toEqual({
      dpr: [1, 1.15],
      ambientIntensity: 0.86,
      hemisphereIntensity: 0.62,
      directionalLights: [
        { position: [4, 6, 7], intensity: 0.72 },
        { position: [-3, 4, -2], intensity: 0.28 },
        { position: [0, 2, 8], intensity: 0.12 }
      ]
    })
  })

  it('keeps a slightly sharper preset for lightweight models', () => {
    expect(resolveModel3DViewerQualityPreset({ fileName: 'scene.glb', textureCount: 0 })).toEqual({
      dpr: [1, 1.45],
      ambientIntensity: 0.86,
      hemisphereIntensity: 0.62,
      directionalLights: [
        { position: [4, 6, 7], intensity: 0.72 },
        { position: [-3, 4, -2], intensity: 0.28 },
        { position: [0, 2, 8], intensity: 0.12 }
      ]
    })
  })
})

describe('resolveModel3DViewerStageBackgroundSx', () => {
  it('uses the exact canvas background color when the canvas is opaque', () => {
    expect(
      resolveModel3DViewerStageBackgroundSx({
        bgColor: '#f5f0e8',
        themeMode: 'light'
      })
    ).toEqual({
      backgroundColor: '#f5f0e8'
    })
  })

  it('uses the shared transparent checker pattern when the canvas background is transparent', () => {
    expect(
      resolveModel3DViewerStageBackgroundSx({
        bgColor: 'transparent',
        transparentPattern: 'repeating-conic-gradient(#888 0% 25%, #555 0% 50%)',
        themeMode: 'dark'
      })
    ).toEqual({
      backgroundImage: 'repeating-conic-gradient(#888 0% 25%, #555 0% 50%)',
      backgroundSize: '20px 20px'
    })
  })
})

describe('Model3DViewerDialog', () => {
  it('uses the shared viewer surface with the lighter viewer render settings', () => {
    const sessionKey = 'canvas:thread:project-1:thread:agent-1'
    renderDialog(baseItem, sessionKey)
    const expectedInstanceCacheKey = getSceneInstanceCloneCacheKey({
      sessionKey,
      src: baseItem.src,
      fileName: baseItem.fileName,
      itemId: baseItem.id
    })

    expect(screen.getByTestId('canvas3d-viewer-surface')).toHaveAttribute(
      'data-dpr',
      JSON.stringify([1, 1.45])
    )
    expect(screen.getByTestId('canvas3d-viewer-surface')).toHaveAttribute(
      'data-render-key',
      expectedInstanceCacheKey
    )
    expect(screen.getAllByText('sample.glb').length).toBeGreaterThan(0)
  })

  it('derives the model clone cache key from the canonical session key', () => {
    const sessionKey = 'canvas:thread:project-9:thread:agent-7'
    renderDialog(baseItem, sessionKey)

    expect(screen.getByTestId('canvas3d-viewer-surface')).toHaveAttribute(
      'data-instance-cache-key',
      getSceneInstanceCloneCacheKey({
        sessionKey,
        src: baseItem.src,
        fileName: baseItem.fileName,
        itemId: baseItem.id
      })
    )
  })

  it('falls back to the shared default session key when sessionKey is omitted', () => {
    renderDialog(baseItem, undefined)

    expect(screen.getByTestId('canvas3d-viewer-surface')).toHaveAttribute(
      'data-instance-cache-key',
      getSceneInstanceCloneCacheKey({
        sessionKey: DEFAULT_CANVAS_MODEL3D_SESSION_KEY,
        src: baseItem.src,
        fileName: baseItem.fileName,
        itemId: baseItem.id
      })
    )
  })

  it('can transition from an empty viewer state to a real model without changing hook order', () => {
    const { rerender } = render(
      <Model3DViewerDialog
        open
        item={null}
        onClose={vi.fn()}
        onDownload={vi.fn()}
        onImportTextures={vi.fn()}
      />
    )

    rerender(
      <Model3DViewerDialog
        open
        item={baseItem}
        onClose={vi.fn()}
        onDownload={vi.fn()}
        onImportTextures={vi.fn()}
      />
    )

    expect(screen.getByTestId('canvas3d-viewer-surface')).toHaveAttribute(
      'data-instance-cache-key',
      getSceneInstanceCloneCacheKey({
        sessionKey: DEFAULT_CANVAS_MODEL3D_SESSION_KEY,
        src: baseItem.src,
        fileName: baseItem.fileName,
        itemId: baseItem.id
      })
    )
  })

  it('changes the viewer render identity when the canonical session key changes', () => {
    const firstSessionKey = 'canvas:thread:project-1:thread:agent-1'
    const secondSessionKey = 'canvas:thread:project-1:thread:agent-2'
    const { rerender } = renderDialog(baseItem, firstSessionKey)

    expect(screen.getByTestId('canvas3d-viewer-surface')).toHaveAttribute(
      'data-render-key',
      getSceneInstanceCloneCacheKey({
        sessionKey: firstSessionKey,
        src: baseItem.src,
        fileName: baseItem.fileName,
        itemId: baseItem.id
      })
    )

    rerender(
      <Model3DViewerDialog
        open
        item={baseItem}
        sessionKey={secondSessionKey}
        onClose={vi.fn()}
        onDownload={vi.fn()}
        onImportTextures={vi.fn()}
      />
    )

    expect(screen.getByTestId('canvas3d-viewer-surface')).toHaveAttribute(
      'data-render-key',
      getSceneInstanceCloneCacheKey({
        sessionKey: secondSessionKey,
        src: baseItem.src,
        fileName: baseItem.fileName,
        itemId: baseItem.id
      })
    )
    expect(screen.getByTestId('canvas3d-viewer-surface')).toHaveAttribute(
      'data-instance-cache-key',
      getSceneInstanceCloneCacheKey({
        sessionKey: secondSessionKey,
        src: baseItem.src,
        fileName: baseItem.fileName,
        itemId: baseItem.id
      })
    )
  })

  it('changes the viewer render identity when the canonical asset source changes', () => {
    const sessionKey = 'canvas:thread:project-1:thread:agent-1'
    const { rerender } = renderDialog(baseItem, sessionKey)

    expect(screen.getByTestId('canvas3d-viewer-surface')).toHaveAttribute(
      'data-render-key',
      getSceneInstanceCloneCacheKey({
        sessionKey,
        src: baseItem.src,
        fileName: baseItem.fileName,
        itemId: baseItem.id
      })
    )

    const swappedSourceItem: CanvasModel3DItem = {
      ...baseItem,
      src: 'blob:mock-model-reimported',
      fileName: 'sample-reimported.glb'
    }

    rerender(
      <Model3DViewerDialog
        open
        item={swappedSourceItem}
        sessionKey={sessionKey}
        onClose={vi.fn()}
        onDownload={vi.fn()}
        onImportTextures={vi.fn()}
      />
    )

    expect(screen.getByTestId('canvas3d-viewer-surface')).toHaveAttribute(
      'data-render-key',
      getSceneInstanceCloneCacheKey({
        sessionKey,
        src: swappedSourceItem.src,
        fileName: swappedSourceItem.fileName,
        itemId: swappedSourceItem.id
      })
    )
    expect(screen.getByTestId('canvas3d-viewer-surface')).toHaveAttribute(
      'data-instance-cache-key',
      getSceneInstanceCloneCacheKey({
        sessionKey,
        src: swappedSourceItem.src,
        fileName: swappedSourceItem.fileName,
        itemId: swappedSourceItem.id
      })
    )
  })
})
