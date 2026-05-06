import { ObjectInfoMap, Workflow } from '@shared/comfy/types'
import { BuildEnv } from '@shared/config/buildEnv'
import { Config } from '@shared/config/config'
import {
  QAppCfgSection,
  QAppCfgInputType,
  QAppCfgAutoType,
  QAppCfgAllComponentTypeMap
} from '@shared/qApp/cfgTypes'
import React from 'react'

export type QAppDesignProps<
  InputType extends QAppCfgInputType | QAppCfgAutoType | 'Section' | 'Description'
> = {
  id: string
  workflow: Workflow
  objectInfos: ObjectInfoMap
  config: Config
  buildEnv: BuildEnv
  value: QAppCfgAllComponentTypeMap[InputType] | null
  setValue: (value: QAppCfgAllComponentTypeMap[InputType]) => void
  onDelete: () => void
}

export type QAppDesignComponent<
  InputType extends QAppCfgInputType | QAppCfgAutoType | 'Section' | 'Description'
> = React.FC<QAppDesignProps<InputType>>
