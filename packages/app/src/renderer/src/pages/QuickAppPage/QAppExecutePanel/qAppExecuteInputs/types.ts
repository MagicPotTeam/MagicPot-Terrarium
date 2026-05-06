import { ObjectInfoMap, Workflow } from '@shared/comfy/types'
import { BuildEnv } from '@shared/config/buildEnv'
import { Config } from '@shared/config/config'
import {
  QAppCfgAllComponentTypeMap,
  QAppCfgAutoType,
  QAppCfgAutoTypeMap,
  QAppCfgInputType
} from '@shared/qApp/cfgTypes'
import React from 'react'

export type ExeInputRef = {
  id: string
  modifyWorkflow: (workflow: Workflow) => void
  validate: (workflow: Workflow) => string // 返回错误信息, 如果没有错误则返回空字符串
}

export type ExeInputProps = {
  objectInfos: ObjectInfoMap
  config: Config
  buildEnv: BuildEnv
  ref: React.Ref<ExeInputRef>
}

// ExeInputComponent 是一个 React Component ，内部自己管理自己的状态
// 通过 ref 与往父组件注册 ref 的方式，提供 modifyWorkflow 和 validate 方法
export type ExeInputComponent = React.FC<ExeInputProps>

// ExeInputBuilder 返回一个 ExeInputComponent
// 每个 QAppInputComponent 内部自己管理自己的状态
export type ExeInputBuilder<InputType extends QAppCfgInputType | 'Description'> = (
  cfg: QAppCfgAllComponentTypeMap[InputType],
  workflow: Workflow
) => ExeInputComponent

export type ExeAutoRef = {
  id: string
  modifyWorkflow: (workflow: Workflow) => void
  validate: (workflow: Workflow) => string // 返回错误信息, 如果没有错误则返回空字符串
}

export type ExeAutoProps = {
  objectInfos: ObjectInfoMap
  config: Config
  buildEnv: BuildEnv
  ref: React.Ref<ExeAutoRef>
}

export type ExeAutoComponent = React.FC<ExeAutoProps>

export type ExeAutoBuilder<AutoType extends QAppCfgAutoType> = (
  cfg: QAppCfgAutoTypeMap[AutoType],
  workflow: Workflow
) => ExeAutoComponent
