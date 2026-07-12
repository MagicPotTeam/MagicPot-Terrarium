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
      setState({ config: configResp.config, buildEnv: buildEnvResp.buildEnv, isReady: true })
      try {
        await api().svcState.watchConfig(
          {},
          {
            onData: (res) => {
              if (!isCurrent()) return
              setState((prev) => ({ ...prev, config: res.config }))
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
      abortSender.abort()
    }
  }, [])

  return createElement(ConfigContext.Provider, { value: state }, children)
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
