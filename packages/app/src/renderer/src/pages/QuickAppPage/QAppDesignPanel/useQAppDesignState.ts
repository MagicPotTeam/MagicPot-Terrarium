import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { ObjectInfoMap, Workflow } from '@shared/comfy/types'
import { getValidQAppImageInputSlots, normalizeQAppBatchConfig } from '@shared/qApp/batchConfig'
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
  qAppCfg: QAppCfg | null,
  objectInfos: ObjectInfoMap = {}
) => {
  const [icon, setIcon] = useState<string>('')
  const [isCustomNodeUrlsEnabled, setIsCustomNodeUrlsEnabled] = useState(false)
  const [customNodeUrls, setCustomNodeUrls] = useState<string[]>([])
  const [autoItems, setAutoItems] = useState<AutoDesignItem[]>([])
  const [inputItems, setInputItems] = useState<InputDesignItem[]>([])
  const [isSpecifyOutput, setIsSpecifyOutput] = useState(false)
  const [hasExplicitOutputConfig, setHasExplicitOutputConfig] = useState(false)
  const [outputNodeIds, setOutputNodeIds] = useState<string[]>([])
  const [isBatchProcessEnabled, setIsBatchProcessEnabled] = useState(false)
  const [batchImageInputSlot, setBatchImageInputSlot] = useState<string>('')
  const batchProcessUserChoiceRef = useRef(false)
  const batchAvailabilityRef = useRef(false)
  const [isRequiredModelsEnabled, setIsRequiredModelsEnabled] = useState(false)
  const [requiredModels, setRequiredModels] = useState<QAppRequiredModel[]>([])

  const configuredImageInputSlots = useMemo(() => {
    const cfg: QAppCfg = {
      icon,
      inputs: inputItems
        .filter((item) => item.value !== null)
        .map((item) => item.value as QAppCfgInput | QAppCfgSection | QAppCfgDescription)
    }
    return globalWorkflow ? getValidQAppImageInputSlots(cfg, globalWorkflow, objectInfos) : []
  }, [globalWorkflow, icon, inputItems, objectInfos])
  const effectiveBatchImageInputSlot =
    batchImageInputSlot && configuredImageInputSlots.includes(batchImageInputSlot)
      ? batchImageInputSlot
      : configuredImageInputSlots.length === 1
        ? configuredImageInputSlots[0]
        : ''
  const isBatchProcessAvailable =
    Boolean(effectiveBatchImageInputSlot) && isSpecifyOutput && outputNodeIds.length > 0

  // Enable the feature the first time the required bindings become available,
  // but do not undo an explicit user choice to turn it off. A loaded config
  // with an explicit batchProcess block is authoritative, including false.
  useEffect(() => {
    if (!isBatchProcessAvailable) {
      batchAvailabilityRef.current = false
      return
    }
    if (
      !batchAvailabilityRef.current &&
      !batchProcessUserChoiceRef.current &&
      !isBatchProcessEnabled
    ) {
      setIsBatchProcessEnabled(true)
    }
    batchAvailabilityRef.current = true
  }, [isBatchProcessAvailable, isBatchProcessEnabled])

  const handleSetBatchProcessEnabled = useCallback((enabled: boolean) => {
    batchProcessUserChoiceRef.current = true
    setIsBatchProcessEnabled(enabled)
  }, [])

  const handleSetBatchImageInputSlot = useCallback((slot: string) => {
    setBatchImageInputSlot(slot)
  }, [])

  const handleSetCustomNodeUrls = useCallback(
    (value: string[] | ((prev: string[]) => string[])) => {
      setCustomNodeUrls((prev) => {
        const next = typeof value === 'function' ? value(prev) : value
        return isEqual(prev, next) ? prev : next
      })
    },
    []
  )

  const handleSetRequiredModels = useCallback(
    (value: QAppRequiredModel[] | ((prev: QAppRequiredModel[]) => QAppRequiredModel[])) => {
      setRequiredModels((prev) => {
        const next = typeof value === 'function' ? value(prev) : value
        return isEqual(prev, next) ? prev : next
      })
    },
    []
  )

  const handleSetOutputNodeIds = useCallback((value: string[] | ((prev: string[]) => string[])) => {
    setOutputNodeIds((prev) => {
      const next = typeof value === 'function' ? value(prev) : value
      return isEqual(prev, next) ? prev : next
    })
  }, [])

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
        const persistedBatchImageInputSlot =
          effectiveBatchImageInputSlot ||
          batchImageInputSlot ||
          baseCfg.batchProcess?.imageInputSlot
        const next = {
          ...baseCfg,
          icon, // <--- Add icon to generated config
          customNodeUrls: isCustomNodeUrlsEnabled ? customNodeUrls : undefined,
          requiredModels: isRequiredModelsEnabled ? requiredModels : undefined,
          outputNodeIds: hasExplicitOutputConfig || isSpecifyOutput ? outputNodeIds : undefined,
          batchProcess:
            (isBatchProcessAvailable ||
              batchProcessUserChoiceRef.current ||
              isBatchProcessEnabled) &&
            persistedBatchImageInputSlot
              ? { enabled: isBatchProcessEnabled, imageInputSlot: persistedBatchImageInputSlot }
              : undefined,
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
    hasExplicitOutputConfig,
    outputNodeIds,
    isBatchProcessEnabled,
    isBatchProcessAvailable,
    effectiveBatchImageInputSlot,
    batchImageInputSlot,
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
      !isBatchProcessEnabled &&
      !batchImageInputSlot &&
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

    const normalizedCfg = normalizeQAppBatchConfig(qAppCfg, globalWorkflow, objectInfos)
    const imageInputSlot =
      normalizedCfg.imageInputSlot || qAppCfg.batchProcess?.imageInputSlot || ''
    const hasBatchBinding = Boolean(imageInputSlot) && normalizedCfg.outputNodeIds.length > 0
    batchProcessUserChoiceRef.current = qAppCfg.batchProcess !== undefined
    batchAvailabilityRef.current = false
    setHasExplicitOutputConfig(Array.isArray(qAppCfg.outputNodeIds))
    setOutputNodeIds(normalizedCfg.outputNodeIds)
    setIsSpecifyOutput(
      Array.isArray(qAppCfg.outputNodeIds) && normalizedCfg.outputNodeIds.length > 0
    )
    setIsBatchProcessEnabled(
      qAppCfg.batchProcess !== undefined ? qAppCfg.batchProcess.enabled === true : hasBatchBinding
    )
    setBatchImageInputSlot(imageInputSlot)
    if (JSON.stringify(normalizedCfg.cfg) !== JSON.stringify(qAppCfg)) {
      setQAppCfg(normalizedCfg.cfg)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalWorkflow])

  /** Load from a QAppCfg (e.g. when user clicks a card or loads a file) */
  const loadFromCfg = useCallback(
    (cfg: QAppCfg, workflowOverride: Workflow | null = globalWorkflow) => {
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

      const normalizedCfg = workflowOverride
        ? normalizeQAppBatchConfig(cfg, workflowOverride, objectInfos)
        : {
            cfg,
            outputNodeIds: cfg.outputNodeIds || [],
            imageInputSlot: undefined,
            canBatch: false,
            imageInputCandidates: [],
            outputNodeCandidates: []
          }
      const imageInputSlot = normalizedCfg.imageInputSlot || cfg.batchProcess?.imageInputSlot || ''
      const hasBatchBinding = Boolean(imageInputSlot) && normalizedCfg.outputNodeIds.length > 0
      batchProcessUserChoiceRef.current = cfg.batchProcess !== undefined
      batchAvailabilityRef.current = false
      setHasExplicitOutputConfig(Array.isArray(cfg.outputNodeIds))
      setOutputNodeIds(normalizedCfg.outputNodeIds)
      setIsSpecifyOutput(Array.isArray(cfg.outputNodeIds) && normalizedCfg.outputNodeIds.length > 0)
      setIsBatchProcessEnabled(
        cfg.batchProcess !== undefined ? cfg.batchProcess.enabled === true : hasBatchBinding
      )
      setBatchImageInputSlot(imageInputSlot)
    },
    [
      globalWorkflow,
      handleSetInputItemValue,
      handleDeleteInputItem,
      handleSetAutoItemValue,
      handleDeleteAutoItem,
      objectInfos
    ]
  )

  /** Reset all design state (e.g. when loading a new workflow file) */
  const resetAll = useCallback(() => {
    setIcon('')
    setCustomNodeUrls([])
    setIsCustomNodeUrlsEnabled(false)
    setRequiredModels([])
    setIsRequiredModelsEnabled(false)
    setHasExplicitOutputConfig(false)
    setOutputNodeIds([])
    setIsSpecifyOutput(false)
    setIsBatchProcessEnabled(false)
    setBatchImageInputSlot('')
    batchProcessUserChoiceRef.current = false
    batchAvailabilityRef.current = false
    setInputItems([])
    setAutoItems([])
  }, [])

  return {
    // icon
    icon,
    setIcon,
    // custom node urls
    customNodeUrls,
    setCustomNodeUrls: handleSetCustomNodeUrls,
    isCustomNodeUrlsEnabled,
    setIsCustomNodeUrlsEnabled,
    // required models
    requiredModels,
    setRequiredModels: handleSetRequiredModels,
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
    setOutputNodeIds: handleSetOutputNodeIds,
    isSpecifyOutput,
    setIsSpecifyOutput,
    // batch process
    isBatchProcessEnabled,
    setIsBatchProcessEnabled: handleSetBatchProcessEnabled,
    batchImageInputSlot: effectiveBatchImageInputSlot,
    batchImageInputSlots: configuredImageInputSlots,
    setBatchImageInputSlot: handleSetBatchImageInputSlot,
    // actions
    loadFromCfg,
    resetAll
  }
}
