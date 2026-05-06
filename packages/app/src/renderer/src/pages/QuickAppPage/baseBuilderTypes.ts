import { QAppCfgAllComponent, QAppCfgAuto, QAppCfgInput } from '@shared/qApp/cfgTypes'
import { JsonPath } from '@shared/utils/jsonPath'

/**
 * 对于 QAppDesign 与 QAppExecute 的输入组件，
 * 如果该输入组件符合一定的条件，逻辑可以复用。
 * 因此，需要定义一些通用的类型和函数，用于构建 QAppDesign 与 QAppExecute 的输入组件。
 */

/**
 * HaveSlotCfgInput 表示有 slot 字段的 QAppCfgInput 子类型
 */
export type HaveSlotCfgInput = Extract<QAppCfgInput, { slot: JsonPath }>
export type HaveSlotCfgInputType = HaveSlotCfgInput['component']

export type HaveSlotCfgAuto = Extract<QAppCfgAuto, { slot: JsonPath }>
export type HaveSlotCfgAutoType = HaveSlotCfgAuto['component']
