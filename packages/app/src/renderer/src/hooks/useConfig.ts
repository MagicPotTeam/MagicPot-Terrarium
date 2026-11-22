import {
  useState,
  useEffect,
  createContext,
  useContext,
  createElement,
  useCallback,
  useRef
} from 'react'
import { api } from '@renderer/utils/windowUtils'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import { isServerStreamingError } from '@shared/api/apiUtils/streaming'
import { Config, DEFAULT_CONFIG } from '@shared/config/config'
import { BuildEnv, DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { ConfigUtils } from '@shared/config/configUtils'
import { DeepPartial } from '@shared/utils/utilTypes'
import { createConfigObservationController } from './configObservation'
import { ConfigObservationProvider } from './configObservationContext'

type ConfigState = {
  config: Config
  buildEnv: BuildEnv
  isReady: boolean
}

const ConfigContext = createContext<ConfigState>({
  config: DEFAULT_CONFIG,
  buildEnv: DEFAULT_BUILD_ENV,
  isReady: false
})

export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const [observation] = useState(createConfigObservationController)
  const [state, setState] = useState<ConfigState>({
    config: DEFAULT_CONFIG,
    buildEnv: DEFAULT_BUILD_ENV,
    isReady: false
  })

  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    const [abortSender, abortReceiver] = newAbortHandler()
    let mounted = true
    const isCurrent = () => mounted && generationRef.current === generation

    const initializeAndWatch = async () => {
      const initialize = () =>
        Promise.all([api().svcState.getConfig({}), api().svcState.getBuildEnv({})])
      let initialized: Awaited<ReturnType<typeof initialize>>
      try {
        initialized = await initialize()
      } catch (err) {
        if (isCurrent()) console.error('useConfig initialize', err)
        return
      }
      if (!isCurrent()) return

      const [configResp, buildEnvResp] = initialized
      const publishObservedConfig = (config: Config): void => {
        if (!isCurrent()) return
        const token = observation.advance(true)
        const ownsObservation = () => isCurrent() && observation.source.getSnapshot() === token
        if (!ownsObservation()) return
        // Observers may synchronously feed a newer message; an older queued update cannot win.
        // Each accepted watch also carries initialized build/readiness if React skipped init.
        setState((previous) => ownsObservation()
          ? { config, buildEnv: buildEnvResp.buildEnv, isReady: true }
          : previous)
      }
      publishObservedConfig(configResp.config)
      if (!isCurrent()) return
      try {
        await api().svcState.watchConfig(
          {},
          {
            onData: (res) => {
              if (!isCurrent()) return
              publishObservedConfig(res.config)
            },
            abortReceiver
          }
        )
      } catch (err) {
        if (!isCurrent() || abortReceiver.isAborted() || isServerStreamingError(err)) return
        console.error('useConfig watchConfig', err)
      }
    }

    void initializeAndWatch()

    return () => {
      mounted = false
      observation.advance(false) // Retire display ownership before abort callbacks can reenter.
      abortSender.abort()
    }
  }, [observation])

  return createElement(ConfigObservationProvider, { value: observation.source },
    createElement(ConfigContext.Provider, { value: state }, children))
}

type UseConfigResult = ConfigState & {
  configUtils: ConfigUtils
  updateConfig: (partial: DeepPartial<Config>) => Promise<void>
}

export function useConfig(): UseConfigResult {
  const context = useContext(ConfigContext)
  if (!context) {
    throw new Error('useConfig must be used within a ConfigProvider')
  }
  const updateConfig = useCallback(async (partial: DeepPartial<Config>) => {
    await api().svcState.saveConfig({ config: partial })
  }, [])
  return {
    ...context,
    configUtils: new ConfigUtils(context.config, context.buildEnv, window.path),
    updateConfig
  }
}
