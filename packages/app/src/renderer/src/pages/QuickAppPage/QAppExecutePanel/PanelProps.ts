import { Config } from '@shared/config/config'
import { ObjectInfoMap } from '@shared/comfy/types'
import { BuildEnv } from '@shared/config/buildEnv'

export interface PanelProps {
  config: Config
  buildEnv: BuildEnv
  clientId: string
  objectInfos: ObjectInfoMap
  isConnected: boolean
  isDesignMode: boolean
}
