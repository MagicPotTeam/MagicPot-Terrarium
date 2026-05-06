import type { WebGLCanvasMode, WebGLCanvasScenePlan } from './webglCanvasTypes'

export function resolveWebGLCanvasScenePlan(
  mode: WebGLCanvasMode,
  hasViewerItems: boolean,
  hasEditorPrimitives: boolean,
  hasMaskPrimitives: boolean
): WebGLCanvasScenePlan {
  const layers: WebGLCanvasScenePlan['layers'] = []
  const capabilities: WebGLCanvasScenePlan['capabilities'] = []

  const viewerEnabled = mode === 'viewer' || mode === 'hybrid' || hasViewerItems
  const editorEnabled = mode === 'editor' || mode === 'hybrid' || hasEditorPrimitives
  const maskEnabled = mode === 'mask' || mode === 'hybrid' || hasMaskPrimitives

  if (viewerEnabled) {
    layers.push('viewer')
    capabilities.push('viewer-path')
  }

  if (editorEnabled) {
    layers.push('editor')
    capabilities.push('editor-path')
  }

  if (maskEnabled) {
    layers.push('mask')
    capabilities.push('mask-path')
  }

  return { layers, capabilities }
}
