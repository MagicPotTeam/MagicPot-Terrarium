import { useState, useEffect, createContext, useContext, createElement, useCallback } from 'react'
import { api } from '@renderer/utils/windowUtils'
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

  useEffect(() => {
    const initialize = async () => {
      const [configResp, buildEnvResp] = await Promise.all([
        api().svcState.getConfig({}),
        api().svcState.getBuildEnv({})
      ])
      setState({ config: configResp.config, buildEnv: buildEnvResp.buildEnv, isReady: true })
    }

    initialize().then(async () => {
      await api()
        .svcState.watchConfig(
          {},
          {
            onData: (res) => {
              setState((prev) => ({ ...prev, config: res.config }))
            }
          }
        )
        .catch((err) => {
          console.error('useConfig watchConfig', err)
        })
    })
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
