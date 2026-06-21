import React from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import BottomPanel from './BottomPanel'
import { joinBoundedLogLines } from './comfyLogRendering'
import { MAX_COMFY_OUTPUT_LINES } from '@renderer/store/slices/comfyProcess'

const dispatchMock = vi.fn()
const clearOutputMock = vi.fn()
let bottomPanelActiveTab = 'elements'

vi.mock('../store', () => ({
  useAppDispatch: () => dispatchMock,
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector({
      layout: {
        bottomPanelVisible: true,
        bottomPanelActiveTab,
        bottomPanelMaximized: false
      }
    })
}))

vi.mock('../store/slices/layoutSlice', () => ({
  toggleBottomPanel: () => ({ type: 'toggleBottomPanel' }),
  toggleBottomPanelMaximized: () => ({ type: 'toggleBottomPanelMaximized' }),
  setBottomPanelTab: (value: unknown) => ({ type: 'setBottomPanelTab', payload: value })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcLog: {
      watchAppLogs: vi.fn(async () => undefined)
    }
  })
}))

vi.mock('@renderer/store/hooks/comfyProcess', () => ({
  useComfyProcess: () => ({
    state: {
      isRunning: false,
      pid: 0,
      output: ['[comfyui] previous run line']
    },
    setPid: vi.fn(),
    setIsRunning: vi.fn(),
    addOutput: vi.fn(),
    clearOutput: clearOutputMock
  })
}))

function expectRowValue(label: string, value: string): void {
  const rows = screen
    .getAllByText(label)
    .map((element) => element.parentElement)
    .filter((element): element is HTMLElement => Boolean(element))
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.some((row) => within(row).queryByText(value))).toBe(true)
}

describe('BottomPanel log rendering', () => {
  it('joins only the bounded ComfyUI log window for rendering', () => {
    const output = joinBoundedLogLines(
      Array.from({ length: 20_000 }, (_, index) => `line-${index}`),
      MAX_COMFY_OUTPUT_LINES
    )

    expect(output.startsWith(`line-${20_000 - MAX_COMFY_OUTPUT_LINES}\n`)).toBe(true)
    expect(output.endsWith('line-19999')).toBe(true)
    expect(output).not.toContain('line-8999\n')
    expect(output.split('\n')).toHaveLength(MAX_COMFY_OUTPUT_LINES)
  })
})

describe('BottomPanel element info', () => {
  beforeEach(() => {
    dispatchMock.mockClear()
    clearOutputMock.mockClear()
    bottomPanelActiveTab = 'elements'
  })

  it('renders richer image, video, and 3D inspection fields with fallback values', async () => {
    render(<BottomPanel />)

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('canvas:selection-info', {
          detail: {
            canvasId: 'canvas-1',
            projectName: 'Project',
            selectionCount: 3,
            structure: {
              selection: {
                itemIds: ['img-1', 'video-1', 'model-1'],
                groupIds: [],
                bounds: { x: 12, y: 24, width: 640, height: 360 }
              },
              selectionItems: [
                {
                  id: 'img-1',
                  type: 'image',
                  x: 12,
                  y: 24,
                  width: 320,
                  height: 213.33,
                  zIndex: 1,
                  locked: false,
                  bounds: { x: 12, y: 24, width: 320, height: 213.33 },
                  fileName: 'hero.png',
                  provenance: {
                    kind: 'external',
                    sourceFileName: 'concept-sheet.psd'
                  }
                },
                {
                  id: 'video-1',
                  type: 'video',
                  x: 360,
                  y: 24,
                  width: 320,
                  height: 180,
                  zIndex: 2,
                  locked: false,
                  bounds: { x: 360, y: 24, width: 320, height: 180 },
                  fileName: 'shot.mp4'
                },
                {
                  id: 'model-1',
                  type: 'model3d',
                  x: 40,
                  y: 280,
                  width: 220,
                  height: 220,
                  zIndex: 3,
                  locked: true,
                  bounds: { x: 40, y: 280, width: 220, height: 220 },
                  fileName: 'character.glb'
                }
              ],
              references: [],
              documents: []
            },
            assetMetadata: [
              {
                itemId: 'img-1',
                type: 'image',
                fileName: 'hero.png',
                mimeType: 'image/png',
                sizeBytes: 1536,
                sourceUrl: 'data:image/png;base64,AAAA',
                extra: {
                  originalFileName: 'concept-sheet.psd',
                  localFileName: 'hero.png',
                  fileFormat: 'PNG',
                  resourceKind: 'data-url',
                  displayAspectRatio: 1.5,
                  rotation: 0,
                  scaleX: 1,
                  scaleY: 1,
                  locked: false,
                  sourceWidth: 1536,
                  sourceHeight: 1024,
                  sourceAspectRatio: 1.5,
                  crop: null,
                  hasAlpha: false,
                  colorSpace: null,
                  textureUsage: null
                }
              },
              {
                itemId: 'video-1',
                type: 'video',
                fileName: 'shot.mp4',
                mimeType: 'video/mp4',
                sourceUrl: 'blob:video-1',
                extra: {
                  originalFileName: 'shot.mp4',
                  localFileName: 'shot.mp4',
                  fileFormat: 'MP4',
                  resourceKind: 'blob-url',
                  displayAspectRatio: 1.778,
                  rotation: 0,
                  scaleX: 1,
                  scaleY: 1,
                  locked: false,
                  sourceWidth: null,
                  sourceHeight: null,
                  sourceAspectRatio: null,
                  durationSeconds: 12.5,
                  currentTimeSeconds: 2.1,
                  fps: null,
                  codec: null,
                  bitrateKbps: null,
                  playing: false,
                  muted: true,
                  volume: 0.5,
                  loop: true,
                  colorSpace: null,
                  audioChannels: null
                }
              },
              {
                itemId: 'model-1',
                type: 'model3d',
                fileName: 'character.glb',
                mimeType: 'model/gltf-binary',
                sourceUrl: 'blob:model-1',
                textures: ['albedo.png', 'normal.png'],
                extra: {
                  originalFileName: 'character.glb',
                  localFileName: 'character.glb',
                  fileFormat: 'GLB',
                  resourceKind: 'blob-url',
                  displayAspectRatio: 1,
                  rotation: 0,
                  scaleX: 1,
                  scaleY: 1,
                  locked: true,
                  textureCount: 2,
                  vertexCount: 4096,
                  faceCount: 2048,
                  materialCount: 3,
                  animationCount: 2,
                  boneCount: 64,
                  uvSetCount: 2,
                  normalData: true,
                  tangentData: false
                }
              }
            ],
            layerIndexByItemId: {
              'img-1': 1,
              'video-1': 2,
              'model-1': 3
            }
          }
        })
      )
    })

    expect(screen.queryByText('\u9009\u533a\u6982\u89c8')).toBeNull()
    expect(screen.queryByText('\u5f53\u524d\u5143\u7d20')).toBeNull()
    expectRowValue('\u539f\u59cb\u6587\u4ef6\u540d', 'concept-sheet.psd')
    expectRowValue('\u672c\u5730\u6587\u4ef6\u540d', 'hero.png')
    expectRowValue('\u6587\u4ef6\u5927\u5c0f', '1.5 KB')
    expect(screen.getByText('1536 x 1024')).toBeTruthy()
    expectRowValue('\u900f\u660e\u901a\u9053', '\u5426')
    expectRowValue('\u65f6\u957f', '0:13')
    expectRowValue('\u8d34\u56fe\u6570\u91cf', '2')
    expectRowValue('\u9876\u70b9\u6570', '4096')
    expectRowValue('\u9762\u6570', '2048')
    expectRowValue('\u6750\u8d28\u6570', '3')
    expectRowValue('\u52a8\u753b\u6570', '2')
    expectRowValue('\u9aa8\u9abc\u6570', '64')
    expectRowValue('UV \u901a\u9053', '2')
    expectRowValue('\u6cd5\u7ebf', '\u662f')
    expectRowValue('\u5207\u7ebf', '\u5426')
  })

  it('caps rendered element detail cards for huge selections', async () => {
    render(<BottomPanel />)

    const selectionItems = Array.from({ length: 75 }, (_, index) => ({
      id: `img-${index + 1}`,
      type: 'image',
      x: index * 12,
      y: index * 8,
      width: 320,
      height: 180,
      zIndex: index,
      locked: false,
      bounds: { x: index * 12, y: index * 8, width: 320, height: 180 },
      fileName: `image-${index + 1}.png`
    }))

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('canvas:selection-info', {
          detail: {
            canvasId: 'canvas-large-selection',
            projectName: 'Project',
            selectionCount: selectionItems.length,
            structure: {
              selection: {
                itemIds: selectionItems.map((item) => item.id),
                groupIds: [],
                bounds: { x: 0, y: 0, width: 2400, height: 1600 }
              },
              selectionItems,
              references: [],
              documents: []
            },
            assetMetadata: [],
            layerIndexByItemId: {}
          }
        })
      )
    })

    expect(screen.getAllByTestId('element-info-card')).toHaveLength(60)
    expect(screen.getByTestId('element-panel-render-limit').textContent).toContain(
      '\u5df2\u9009 75 \u4e2a\u5143\u7d20'
    )
  })

  it('allows clearing the dedicated ComfyUI log panel', () => {
    bottomPanelActiveTab = 'comfyui'

    render(<BottomPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'terminal.clear' }))

    expect(clearOutputMock).toHaveBeenCalledTimes(1)
  })
})
