import { useCallback, useEffect, useState } from 'react'
import {
  QAppCfg,
  QAppCfgSection,
  QAppCfgInputType,
  QAppCfgAllComponentTypeMap,
  QAppCfgAutoType,
  QAppCfgAutoTypeMap,
  QAppCfgDescription,
  QAppCfgInput,
  QAppRequiredModel
} from '@shared/qApp/cfgTypes'
import { Workflow } from '@shared/comfy/types'
import { DesignItem } from './QAppDesignPopUpPanel'
import { isEqual } from 'es-toolkit'

type InputCompValue = QAppCfgAllComponentTypeMap[QAppCfgInputType | 'Section' | 'Description']
type AutoCompValue = QAppCfgAutoTypeMap[QAppCfgAutoType]
export type InputDesignItem = DesignItem<QAppCfgInputType | 'Section' | 'Description'>
export type AutoDesignItem = DesignItem<QAppCfgAutoType>

/**
 * 快应用设计面板的状态管理 Hook
 *
 * 将所有 design state（customNodeUrls, requiredModels, autoItems, inputItems, outputNodeIds）
 * 和相关的 handler 封装到一个 hook 中，减少 prop drilling。
 */
export const useQAppDesignState = (
  setQAppCfg: React.Dispatch<React.SetStateAction<QAppCfg | null>>,
  globalWorkflow: Workflow | null,
  qAppCfg: QAppCfg | null
) => {
  const [icon, setIcon] = useState<string>('')
  const [isCustomNodeUrlsEnabled, setIsCustomNodeUrlsEnabled] = useState(false)
  const [customNodeUrls, setCustomNodeUrls] = useState<string[]>([])
  const [autoItems, setAutoItems] = useState<AutoDesignItem[]>([])
  const [inputItems, setInputItems] = useState<InputDesignItem[]>([])
  const [isSpecifyOutput, setIsSpecifyOutput] = useState(false)
  const [outputNodeIds, setOutputNodeIds] = useState<string[]>([])
  const [isRequiredModelsEnabled, setIsRequiredModelsEnabled] = useState(false)
  const [requiredModels, setRequiredModels] = useState<QAppRequiredModel[]>([])

  // --- handlers ---
  const handleSetAutoItemValue = useCallback((id: string, value: AutoCompValue) => {
    setAutoItems((prev) => {
      let changed = false
      const next = prev.map((item) => {
        if (item.id !== id) return item
        if (isEqual(item.value, value)) return item
        changed = true
        return { ...item, value }
      })
      return changed ? next : prev
    })
  }, [])
  const handleDeleteAutoItem = useCallback((id: string) => {
    setAutoItems((prev) => prev.filter((item) => item.id !== id))
  }, [])
  const handleSetInputItemValue = useCallback((id: string, value: InputCompValue) => {
    setInputItems((prev) => {
      let changed = false
      const next = prev.map((item) => {
        if (item.id !== id) return item
        if (isEqual(item.value, value)) return item
        changed = true
        return { ...item, value }
      })
      return changed ? next : prev
    })
  }, [])
  const handleDeleteInputItem = useCallback((id: string) => {
    setInputItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  // --- sync to qAppCfg ---
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setQAppCfg((prev: QAppCfg | null) => {
        const baseCfg = prev || { icon: '', inputs: [], autoInputs: [] }
        const next = {
          ...baseCfg,
          icon, // <--- Add icon to generated config
          customNodeUrls: isCustomNodeUrlsEnabled ? customNodeUrls : undefined,
          requiredModels: isRequiredModelsEnabled ? requiredModels : undefined,
          outputNodeIds: isSpecifyOutput ? outputNodeIds : undefined,
          inputs: inputItems
            .filter((item) => item.value !== null)
            .map((item) => item.value as QAppCfgInput | QAppCfgSection | QAppCfgDescription),
          autoInputs: autoItems
            .filter((item) => item.value !== null)
            .map((item) => item.value as QAppCfgAutoTypeMap[QAppCfgAutoType])
        }
        // Prevent unnecessary context updates that cause render cascades
        if (JSON.stringify(prev) === JSON.stringify(next)) return prev
        return next
      })
    }, 0)
    return () => clearTimeout(timeoutId)
  }, [
    inputItems,
    autoItems,
    isSpecifyOutput,
    outputNodeIds,
    isCustomNodeUrlsEnabled,
    customNodeUrls,
    isRequiredModelsEnabled,
    requiredModels,
    icon,
    setQAppCfg
  ])

  // --- populate from qAppCfg (reverse fill) ---
  useEffect(() => {
    if (!globalWorkflow || !qAppCfg) return
    const isLocalEmpty =
      inputItems.length === 0 &&
      autoItems.length === 0 &&
      customNodeUrls.length === 0 &&
      outputNodeIds.length === 0 &&
      !isCustomNodeUrlsEnabled &&
      !isSpecifyOutput

    if (!isLocalEmpty) return

    setCustomNodeUrls(qAppCfg.customNodeUrls || [])
    setIsCustomNodeUrlsEnabled(!!qAppCfg.customNodeUrls)
    setIcon(qAppCfg.icon || '')
    setRequiredModels(qAppCfg.requiredModels || [])
    setIsRequiredModelsEnabled(!!qAppCfg.requiredModels)

    const newInputs: InputDesignItem[] = qAppCfg.inputs.map((input) => {
      const id = crypto.randomUUID()
      const compType = input.component as QAppCfgInputType | 'Section' | 'Description'
      return {
        id,
        component: compType,
        value: input as InputCompValue,
        setValue: (value: InputCompValue) => handleSetInputItemValue(id, value),
        onDelete: () => handleDeleteInputItem(id)
      }
    })
    setInputItems(newInputs)

    const newAutoItems: AutoDesignItem[] =
      qAppCfg.autoInputs?.map((auto) => {
        const id = crypto.randomUUID()
        return {
          id,
          component: auto.component as QAppCfgAutoType,
          value: auto,
          setValue: (value: AutoCompValue) => handleSetAutoItemValue(id, value),
          onDelete: () => handleDeleteAutoItem(id)
        }
      }) ?? []
    setAutoItems(newAutoItems)

    setOutputNodeIds(qAppCfg.outputNodeIds || [])
    setIsSpecifyOutput(!!qAppCfg.outputNodeIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalWorkflow])

  /** Load from a QAppCfg (e.g. when user clicks a card or loads a file) */
  const loadFromCfg = useCallback(
    (cfg: QAppCfg) => {
      setCustomNodeUrls(cfg.customNodeUrls || [])
      setIsCustomNodeUrlsEnabled(!!cfg.customNodeUrls)
      setIcon(cfg.icon || '')
      setRequiredModels(cfg.requiredModels || [])
      setIsRequiredModelsEnabled(!!cfg.requiredModels)

      const loadedInputs: InputDesignItem[] = cfg.inputs.map((input) => {
        const id = crypto.randomUUID()
        return {
          id,
          component: input.component as QAppCfgInputType,
          value: input as InputCompValue,
          setValue: (v: InputCompValue) => handleSetInputItemValue(id, v),
          onDelete: () => handleDeleteInputItem(id)
        }
      })
      setInputItems(loadedInputs)

      const loadedAuto: AutoDesignItem[] =
        cfg.autoInputs?.map((auto) => {
          const id = crypto.randomUUID()
          return {
            id,
            component: auto.component as QAppCfgAutoType,
            value: auto,
            setValue: (v: AutoCompValue) => handleSetAutoItemValue(id, v),
            onDelete: () => handleDeleteAutoItem(id)
          }
        }) ?? []
      setAutoItems(loadedAuto)

      setOutputNodeIds(cfg.outputNodeIds || [])
      setIsSpecifyOutput(!!cfg.outputNodeIds)
    },
    [handleSetInputItemValue, handleDeleteInputItem, handleSetAutoItemValue, handleDeleteAutoItem]
  )

  /** Reset all design state (e.g. when loading a new workflow file) */
  const resetAll = useCallback(() => {
    setIcon('')
    setCustomNodeUrls([])
    setIsCustomNodeUrlsEnabled(false)
    setRequiredModels([])
    setIsRequiredModelsEnabled(false)
    setOutputNodeIds([])
    setIsSpecifyOutput(false)
    setInputItems([])
    setAutoItems([])
  }, [])

  return {
    // icon
    icon,
    setIcon,
    // custom node urls
    customNodeUrls,
    setCustomNodeUrls,
    isCustomNodeUrlsEnabled,
    setIsCustomNodeUrlsEnabled,
    // required models
    requiredModels,
    setRequiredModels,
    isRequiredModelsEnabled,
    setIsRequiredModelsEnabled,
    // auto items
    autoItems,
    setAutoItems,
    handleSetAutoItemValue,
    handleDeleteAutoItem,
    // input items
    inputItems,
    setInputItems,
    handleSetInputItemValue,
    handleDeleteInputItem,
    // output
    outputNodeIds,
    setOutputNodeIds,
    isSpecifyOutput,
    setIsSpecifyOutput,
    // actions
    loadFromCfg,
    resetAll
  }
}
