import React, { useCallback, useEffect, useState } from 'react'
import { PanelProps } from './PanelProps'
import { useMessage } from '@renderer/hooks/useMessage'
import buildQApp from './buildQApp'
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import { useConfig } from '@renderer/hooks/useConfig'
import { useQAppContext } from '../components/QAppContext'
import { getQAppSessionKey } from '../utils/qAppSessionIdentity'

type QAppPanelProps = {
  fallback: React.ReactNode
  isDesignMode?: boolean
}

/**
 * QApp 封装组件
 * 将获取 QApp 配置、构建 QApp 组件逻辑封装在一起
 * 外部只需传入 QApp key
 * @param param0
 * @returns
 */
const QAppPanel: React.FC<QAppPanelProps> = ({ fallback, isDesignMode }) => {
  const { notifyError } = useMessage()
  const { config, buildEnv } = useConfig()
  const { workflow, qAppCfg, isLoading, currentQAppKey } = useQAppContext()
  const client_id = currentQAppKey
    ? getQAppSessionKey({ qAppKey: currentQAppKey })
    : config.client_id

  const [Panel, setPanel] = useState<React.FC<PanelProps> | null>(null)

  // QuickApp 全局状态
  const {
    state: { isConnected, objectInfos }
  } = useComfyStatus()

  const buildQAppInputPanel = useCallback(() => {
    if (!qAppCfg || !workflow) {
      return
    }
    try {
      const NewPanel = buildQApp(qAppCfg, workflow)
      setPanel(() => NewPanel)
    } catch (error) {
      notifyError(`构建 QApp 输入面板失败: ${error}`)
      setPanel(null)
    }
  }, [notifyError, qAppCfg, workflow])

  useEffect(() => {
    buildQAppInputPanel()
  }, [buildQAppInputPanel])

  const panelProps: PanelProps = {
    objectInfos,
    config,
    buildEnv,
    clientId: client_id,
    isConnected,
    isDesignMode: isDesignMode ?? false
  }

  // 如果正在加载，显示 fallback
  if (isLoading) {
    return <>{fallback}</>
  }

  // 如果加载完成但没有 Panel（例如 config 为空或构建失败），显示空内容
  if (!Panel) {
    return null
  }

  return <Panel {...panelProps} />
}

export default QAppPanel
