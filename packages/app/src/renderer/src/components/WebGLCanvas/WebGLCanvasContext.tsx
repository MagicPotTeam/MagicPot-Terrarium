/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext } from 'react'
import type { Application, Container } from 'pixi.js'
import type { WebGLCanvasHostState } from './webglCanvasTypes'

export type WebGLCanvasRuntime = {
  app: Application
  world: Container
  state: WebGLCanvasHostState
}

const WebGLCanvasContext = createContext<WebGLCanvasRuntime | null>(null)

export function useWebGLCanvasRuntime(): WebGLCanvasRuntime | null {
  return useContext(WebGLCanvasContext)
}

export function useRequiredWebGLCanvasRuntime(): WebGLCanvasRuntime {
  const runtime = useWebGLCanvasRuntime()
  if (!runtime) {
    throw new Error('WebGLCanvas runtime is not ready')
  }
  return runtime
}

export default WebGLCanvasContext
