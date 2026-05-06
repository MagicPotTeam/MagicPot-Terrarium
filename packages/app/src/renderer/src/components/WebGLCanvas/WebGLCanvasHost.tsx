import { Box } from '@mui/material'
import { Application, Container } from 'pixi.js'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import WebGLCanvasContext, { type WebGLCanvasRuntime } from './WebGLCanvasContext'
import type {
  WebGLCanvasCapability,
  WebGLCanvasHostState,
  WebGLCanvasMode
} from './webglCanvasTypes'

function resolveHostCapabilities(mode: WebGLCanvasMode): WebGLCanvasCapability[] {
  if (mode === 'hybrid') {
    return ['viewer-path', 'editor-path', 'mask-path']
  }

  if (mode === 'editor') {
    return ['editor-path']
  }

  if (mode === 'mask') {
    return ['mask-path']
  }

  return ['viewer-path']
}

type WebGLCanvasHostProps = {
  mode?: WebGLCanvasMode
  onReadyChange?: (ready: boolean) => void
  onRuntimeChange?: (runtime: WebGLCanvasRuntime | null) => void
  children?: React.ReactNode
}

export default function WebGLCanvasHost({
  mode = 'viewer',
  onReadyChange,
  onRuntimeChange,
  children
}: WebGLCanvasHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<Application | null>(null)
  const worldRef = useRef<Container | null>(null)
  const [state, setState] = useState<WebGLCanvasHostState>({
    ready: false,
    mode,
    capabilities: resolveHostCapabilities(mode)
  })

  useEffect(() => {
    setState((current) => ({ ...current, mode }))
  }, [mode])

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }

    let disposed = false

    const initialize = async () => {
      const app = new Application()
      await app.init({
        resizeTo: host,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        autoStart: false,
        sharedTicker: false,
        preference: 'webgl',
        powerPreference: 'high-performance'
      })

      if (disposed) {
        app.destroy(true, { children: true })
        return
      }

      const world = new Container()
      world.sortableChildren = true
      app.stage.addChild(world)

      appRef.current = app
      worldRef.current = world
      host.replaceChildren(app.canvas as HTMLCanvasElement)

      const runtime: WebGLCanvasRuntime = {
        app,
        world,
        state: {
          ready: true,
          mode,
          capabilities: resolveHostCapabilities(mode)
        }
      }

      setState(runtime.state)
      onReadyChange?.(true)
      onRuntimeChange?.(runtime)
    }

    void initialize()

    return () => {
      disposed = true
      onReadyChange?.(false)
      onRuntimeChange?.(null)
      worldRef.current = null
      if (appRef.current) {
        appRef.current.destroy(true, { children: true })
        appRef.current = null
      }
      host.replaceChildren()
      setState({
        ready: false,
        mode,
        capabilities: resolveHostCapabilities(mode)
      })
    }
  }, [mode, onReadyChange, onRuntimeChange])

  const runtime = useMemo<WebGLCanvasRuntime | null>(() => {
    if (!appRef.current || !worldRef.current) {
      return null
    }

    return {
      app: appRef.current,
      world: worldRef.current,
      state
    }
  }, [state])

  return (
    <WebGLCanvasContext.Provider value={runtime}>
      <Box
        ref={hostRef}
        sx={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          pointerEvents: 'none'
        }}
      />
      {runtime ? children : null}
    </WebGLCanvasContext.Provider>
  )
}
