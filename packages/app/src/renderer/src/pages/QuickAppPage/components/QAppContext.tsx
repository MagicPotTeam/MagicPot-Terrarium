/* eslint-disable react-refresh/only-export-components, @typescript-eslint/no-explicit-any */
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import { Workflow } from '@shared/comfy/types'
import { QAppCfg, QAppCfgInput } from '@shared/qApp/cfgTypes'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { getJsonPath } from '@shared/utils/jsonPath'
import { valueToFileItem, fileItemToValue } from '@shared/comfy/funcs'
import { JsonDict } from '@shared/utils/utilTypes'
import {
  clearPendingQAppTaskPack,
  QAPP_APPLY_TASK_PACK_EVENT,
  readPendingQAppTaskPack,
  type QAppApplyTaskPackDetail
} from '../utils/qAppTaskPackBridge'

type QAppContextType = {
  qAppCfg: QAppCfg | null
  workflow: Workflow | null
  setQAppCfg: React.Dispatch<React.SetStateAction<QAppCfg | null>>
  setWorkflow: React.Dispatch<React.SetStateAction<Workflow | null>>
  submitClientId?: string
  submitSessionKey?: string
  validate?: () => boolean
  buildWorkflow?: () => Workflow
  buildSubmitExtraData?: () => JsonDict | undefined
  setSubmitClientId: (clientId: string | undefined) => void
  setSubmitSessionKey: (sessionKey: string | undefined) => void
  setValidate: (validate: (() => boolean) | undefined) => void
  setBuildWorkflow: (buildWorkflow: (() => Workflow) | undefined) => void
  setBuildSubmitExtraData: (buildSubmitExtraData: (() => JsonDict | undefined) | undefined) => void
  formState: Map<string, unknown>
  setFormStateValue: (key: string, value: unknown) => void
  currentQAppKey?: string
  isLoading: boolean
}

const QAppContext = createContext<QAppContextType>({
  qAppCfg: null,
  workflow: null,
  setQAppCfg: () => {},
  setWorkflow: () => {},
  submitClientId: undefined,
  submitSessionKey: undefined,
  validate: undefined,
  buildWorkflow: undefined,
  buildSubmitExtraData: undefined,
  setSubmitClientId: () => {},
  setSubmitSessionKey: () => {},
  setValidate: () => {},
  setBuildWorkflow: () => {},
  setBuildSubmitExtraData: () => {},
  formState: new Map(),
  setFormStateValue: () => {},
  currentQAppKey: undefined,
  isLoading: false
})

type QAppContextProviderProps = {
  qAppKey?: string
  // 设计模式等场景下，只使用前端状态和缓存，不从服务端拉取配置
  skipServerFetch?: boolean
  children: React.ReactNode
}

// 将缓存提升到模块级别，这样即使组件卸载和重新挂载，缓存也不会丢失
type QAppCacheEntry = {
  cfg: QAppCfg | null
  workflow: Workflow | null
  formState: Map<string, unknown>
}

const qAppCache = new Map<string, QAppCacheEntry>()

const cloneQAppCacheEntry = (entry: QAppCacheEntry): QAppCacheEntry => ({
  cfg: entry.cfg,
  workflow: entry.workflow,
  formState: new Map(entry.formState)
})

const isPlainQAppValueRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const qAppInputValueEquals = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }

    return left.every((item, index) => qAppInputValueEquals(item, right[index]))
  }

  if (isPlainQAppValueRecord(left) || isPlainQAppValueRecord(right)) {
    if (!isPlainQAppValueRecord(left) || !isPlainQAppValueRecord(right)) {
      return false
    }

    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) {
      return false
    }

    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        qAppInputValueEquals(left[key], right[key])
    )
  }

  return false
}

export const QAppContextProvider = ({
  qAppKey,
  skipServerFetch,
  children
}: QAppContextProviderProps) => {
  // 初始化时就从缓存恢复 formState，确保在组件挂载时就有正确的值
  const [qAppCfg, setQAppCfg] = useState<QAppCfg | null>(() => {
    if (!qAppKey) return null
    const cached = qAppCache.get(qAppKey)
    return cached?.cfg ?? null
  })
  const [workflow, setWorkflow] = useState<Workflow | null>(() => {
    if (!qAppKey) return null
    const cached = qAppCache.get(qAppKey)
    return cached?.workflow ?? null
  })
  const [validate, setValidateInternal] = useState<(() => boolean) | undefined>(undefined)
  const [buildWorkflow, setBuildWorkflowInternal] = useState<(() => Workflow) | undefined>(
    undefined
  )
  const [buildSubmitExtraData, setBuildSubmitExtraDataInternal] = useState<
    (() => JsonDict | undefined) | undefined
  >(undefined)
  const [submitClientId, setSubmitClientIdInternal] = useState<string | undefined>(undefined)
  const [submitSessionKey, setSubmitSessionKeyInternal] = useState<string | undefined>(undefined)
  const { notifyError } = useMessage()
  const [formState, setFormState] = useState<Map<string, unknown>>(() => {
    if (!qAppKey) return new Map()
    const cached = qAppCache.get(qAppKey)
    return cached?.formState ? new Map(cached.formState) : new Map()
  })
  const pendingWorkflowRef = useRef<Workflow | null>(null)
  const pendingTaskPackRef = useRef<QAppApplyTaskPackDetail | null>(null)
  const fillParamsFromWorkflowRef = useRef<
    ((sourceWorkflow: Workflow, cfg: QAppCfg | null) => void) | null
  >(null)
  const [isLoading, setIsLoading] = useState(false)

  // Block cache writeback while an invalidation→refetch cycle is in progress
  // to prevent stale state from being written back into the cache.
  const cacheWriteBlockedRef = useRef(false)

  // Listen for cache invalidation events (e.g. after save/delete of a QApp with the same name)
  // This forces the provider to clear stale state and re-fetch from server
  const [cacheInvalidationTick, setCacheInvalidationTick] = useState(0)
  useEffect(() => {
    const handler = (e: Event) => {
      const key = (e as CustomEvent).detail?.key
      if (key && key === qAppKey) {
        // Block cache writeback immediately so the stale state cannot be
        // re-persisted into the module-level cache before React flushes
        // the null/empty state updates below.
        cacheWriteBlockedRef.current = true
        // The cache for our current key was cleared externally
        // Reset local state so the fetch effect re-runs with fresh data
        setQAppCfg(null)
        setWorkflow(null)
        setFormState(new Map())
        setCacheInvalidationTick((prev) => prev + 1)
      }
    }
    window.addEventListener('qapp:cache-invalidated', handler)
    return () => window.removeEventListener('qapp:cache-invalidated', handler)
  }, [qAppKey])

  // 先定义 setFormStateValue，因为 fillParamsFromWorkflow 需要使用它
  const setFormStateValue = useCallback((key: string, value: unknown) => {
    setFormState((prev) => {
      const current = prev.get(key)
      if (prev.has(key) && qAppInputValueEquals(current, value)) {
        return prev
      }
      const next = new Map(prev)
      next.set(key, value)
      return next
    })
  }, [])

  // 从工作流中提取参数并填充到表单
  const applyTaskPackToInputs = useCallback(
    async (detail: QAppApplyTaskPackDetail, cfg: QAppCfg | null) => {
      if (!cfg || !qAppKey || detail.qAppKey !== qAppKey) {
        return
      }

      const promptInput = cfg.inputs.find(
        (input): input is Extract<QAppCfgInput, { component: 'InputPrompt' }> =>
          input.component === 'InputPrompt'
      )
      const imageInputs = cfg.inputs.filter(
        (input): input is Extract<QAppCfgInput, { component: 'InputComfyImage' }> =>
          input.component === 'InputComfyImage'
      )

      if (promptInput) {
        setFormStateValue(promptInput.slot, detail.promptText)
      }

      for (const [index, imageInput] of imageInputs.entries()) {
        const source = detail.referenceImages[index]
        if (!source) {
          break
        }

        try {
          const response = await fetch(source.src)
          const blob = await response.blob()
          const file = new File([blob], source.fileName || `reference-${index + 1}.png`, {
            type: blob.type || 'image/png'
          })
          const uploadRes = await api().svcComfy.uploadImage({
            fileItem: { filename: file.name, type: 'input' },
            image: new Uint8Array(await file.arrayBuffer())
          })

          if (uploadRes.filename) {
            setFormStateValue(imageInput.slot, fileItemToValue(uploadRes))
          }
        } catch (error) {
          console.warn('[QAppContext] failed to apply task-pack image:', error)
        }
      }

      pendingTaskPackRef.current = null
      clearPendingQAppTaskPack(detail.qAppKey)
    },
    [qAppKey, setFormStateValue]
  )

  const fillParamsFromWorkflow = useCallback(
    (sourceWorkflow: Workflow, cfg: QAppCfg | null) => {
      if (!cfg) {
        return
      }

      // 遍历所有输入项，从工作流中提取参数值
      for (const input of cfg.inputs) {
        if (input.component === 'Section' || input.component === 'Description') {
          continue
        }

        const inputCfg = input as QAppCfgInput

        // 处理有slot的输入项
        if ('slot' in inputCfg) {
          try {
            const value = getJsonPath(inputCfg.slot, sourceWorkflow)
            if (value !== undefined) {
              // 如果是图片输入，需要从ComfyUI获取图片并重新上传
              if (
                inputCfg.component === 'InputComfyImage' ||
                inputCfg.component === 'InputComfyImageMask'
              ) {
                console.log(
                  `[fillParamsFromWorkflow] 图片输入 ${inputCfg.slot}:`,
                  value,
                  typeof value
                )

                // 如果值是字符串（文件名），尝试从ComfyUI获取图片并重新上传
                if (typeof value === 'string' && value.trim()) {
                  // 先设置原值，确保图片能立即显示
                  console.log(`[fillParamsFromWorkflow] 设置图片原值 ${inputCfg.slot}:`, value)
                  setFormStateValue(inputCfg.slot, value)

                  // 然后异步尝试重新上传图片
                  ;(async () => {
                    try {
                      const fileItem = valueToFileItem(value)
                      console.log(`[fillParamsFromWorkflow] 尝试从ComfyUI获取图片:`, fileItem)

                      // 从ComfyUI获取图片数据
                      const viewRes = await api().svcComfy.getView(fileItem)
                      const imageBytes = viewRes.result

                      // 将图片数据转换为File对象
                      const blob = new Blob([imageBytes as BlobPart], { type: 'image/png' })
                      const file = new File([blob], fileItem.filename || 'image.png', {
                        type: 'image/png'
                      })

                      // 上传图片到ComfyUI
                      const arrayBuffer = await file.arrayBuffer()
                      const uint8 = new Uint8Array(arrayBuffer)
                      const uploadRes = await api().svcComfy.uploadImage({
                        fileItem: { filename: file.name, type: 'input' },
                        image: uint8
                      })

                      if (uploadRes.filename) {
                        // 使用新上传的图片值
                        const newValue = fileItemToValue(uploadRes)
                        console.log(
                          `[fillParamsFromWorkflow] 图片上传成功，更新值 ${inputCfg.slot}:`,
                          newValue
                        )
                        setFormStateValue(inputCfg.slot, newValue)
                      }
                    } catch (error) {
                      // 如果获取或上传失败，保持原值不变（已经在上面设置了）
                      console.warn(
                        `[fillParamsFromWorkflow] 无法重新上传图片 ${inputCfg.slot}:`,
                        error
                      )
                    }
                  })()
                } else if (Array.isArray(value) && value.length === 2) {
                  // 如果值是数组（节点输出），直接使用原值
                  console.log(
                    `[fillParamsFromWorkflow] 图片值为数组（节点输出）${inputCfg.slot}:`,
                    value
                  )
                  setFormStateValue(inputCfg.slot, value)
                } else {
                  // 其他情况，直接设置值
                  console.log(`[fillParamsFromWorkflow] 图片值其他格式 ${inputCfg.slot}:`, value)
                  setFormStateValue(inputCfg.slot, value)
                }
              } else {
                // 非图片输入，直接设置值
                setFormStateValue(inputCfg.slot, value)
              }
            }
          } catch (error) {
            // 忽略提取失败的情况
            console.warn(`无法从工作流中提取参数 ${inputCfg.slot}:`, error)
          }
        }

        // 处理InputImageSize的特殊情况（可能有seperateSlots）
        if (inputCfg.component === 'InputImageSize' && 'seperateSlots' in inputCfg) {
          if (inputCfg.seperateSlots && 'widthSlot' in inputCfg && 'heightSlot' in inputCfg) {
            try {
              const width = getJsonPath(inputCfg.widthSlot, sourceWorkflow)
              const height = getJsonPath(inputCfg.heightSlot, sourceWorkflow)
              if (width !== undefined) {
                setFormStateValue(inputCfg.widthSlot, width)
              }
              if (height !== undefined) {
                setFormStateValue(inputCfg.heightSlot, height)
              }
            } catch (error) {
              console.warn(`无法从工作流中提取图片尺寸参数:`, error)
            }
          } else if (!inputCfg.seperateSlots && 'nodeSlot' in inputCfg) {
            try {
              const nodeValue = getJsonPath(inputCfg.nodeSlot, sourceWorkflow)
              if (nodeValue !== undefined && typeof nodeValue === 'object' && nodeValue !== null) {
                const nodeValueObj = nodeValue as { width?: number; height?: number }
                const width = nodeValueObj.width
                const height = nodeValueObj.height
                if (width !== undefined) {
                  setFormStateValue(`${inputCfg.nodeSlot}.width`, width)
                }
                if (height !== undefined) {
                  setFormStateValue(`${inputCfg.nodeSlot}.height`, height)
                }
              }
            } catch (error) {
              console.warn(`无法从工作流中提取图片尺寸参数:`, error)
            }
          }
        }

        // 处理InputLLMAPI的特殊情况
        if (inputCfg.component === 'InputLLMAPI' && 'seperateSlots' in inputCfg) {
          if (inputCfg.seperateSlots) {
            if ('modelNameSlot' in inputCfg) {
              try {
                const value = getJsonPath(inputCfg.modelNameSlot, sourceWorkflow)
                if (value !== undefined) {
                  setFormStateValue(inputCfg.modelNameSlot, value)
                }
              } catch (error) {
                console.warn(`无法从工作流中提取模型名称:`, error)
              }
            }
            if ('baseUrlSlot' in inputCfg) {
              try {
                const value = getJsonPath(inputCfg.baseUrlSlot, sourceWorkflow)
                if (value !== undefined) {
                  setFormStateValue(inputCfg.baseUrlSlot, value)
                }
              } catch (error) {
                console.warn(`无法从工作流中提取基础URL:`, error)
              }
            }
            if ('apiKeySlot' in inputCfg) {
              try {
                const value = getJsonPath(inputCfg.apiKeySlot, sourceWorkflow)
                if (value !== undefined) {
                  setFormStateValue(inputCfg.apiKeySlot, value)
                }
              } catch (error) {
                console.warn(`无法从工作流中提取API密钥:`, error)
              }
            }
          } else if ('nodeSlot' in inputCfg) {
            try {
              const nodeValue = getJsonPath(inputCfg.nodeSlot, sourceWorkflow)
              if (nodeValue !== undefined && typeof nodeValue === 'object' && nodeValue !== null) {
                const nodeValueObj = nodeValue as {
                  model_name?: string
                  base_url?: string
                  api_key?: string
                }
                const modelName = nodeValueObj.model_name
                const baseUrl = nodeValueObj.base_url
                const apiKey = nodeValueObj.api_key
                if (modelName !== undefined) {
                  setFormStateValue(`${inputCfg.nodeSlot}.model_name`, modelName)
                }
                if (baseUrl !== undefined) {
                  setFormStateValue(`${inputCfg.nodeSlot}.base_url`, baseUrl)
                }
                if (apiKey !== undefined) {
                  setFormStateValue(`${inputCfg.nodeSlot}.api_key`, apiKey)
                }
              }
            } catch (error) {
              console.warn(`无法从工作流中提取LLM API参数:`, error)
            }
          }
        }

        // 处理 InputLoRAChain 的特殊情况：从工作流中提取 LoRA 节点信息
        if (inputCfg.component === 'InputLoRAChain') {
          try {
            const loraLabel = inputCfg.label || ''
            const outputModelSlots =
              'outputModelSlots' in inputCfg ? (inputCfg as any).outputModelSlots : []
            const outputClipSlots =
              'outputClipSlots' in inputCfg ? (inputCfg as any).outputClipSlots : []
            const formKey = `${loraLabel}-${(outputModelSlots || []).join('|')}-${(outputClipSlots || []).join('|')}`

            // 从 workflow 中查找以 "QAppInputLoRAChain-{label}_" 开头的 LoRA 节点
            const prefix = `QAppInputLoRAChain-${loraLabel}_`
            const loraConfigs: Array<{
              lora_name: string
              strength_model: number
              strength_clip: number
            }> = []

            // 收集所有匹配的 LoRA 节点
            const matchingKeys = Object.keys(sourceWorkflow)
              .filter((k) => k.startsWith(prefix))
              .sort() // 按名称排序确保顺序正确

            for (const nodeKey of matchingKeys) {
              const node = sourceWorkflow[nodeKey] as any
              if (node && node.class_type === 'LoraLoader' && node.inputs) {
                loraConfigs.push({
                  lora_name: node.inputs.lora_name || '',
                  strength_model:
                    typeof node.inputs.strength_model === 'number'
                      ? node.inputs.strength_model
                      : 1.0,
                  strength_clip:
                    typeof node.inputs.strength_clip === 'number' ? node.inputs.strength_clip : 1.0
                })
              }
            }

            if (loraConfigs.length > 0) {
              console.log(
                `[fillParamsFromWorkflow] 提取到 ${loraConfigs.length} 个 LoRA:`,
                loraConfigs.map((l) => l.lora_name)
              )
              setFormStateValue(formKey, loraConfigs)
            }
          } catch (error) {
            console.warn(`无法从工作流中提取LoRA参数:`, error)
          }
        }
      }
    },
    [setFormStateValue]
  )

  // 使用useEffect更新ref，避免在渲染期间直接赋值
  useEffect(() => {
    fillParamsFromWorkflowRef.current = fillParamsFromWorkflow
  }, [fillParamsFromWorkflow])

  useEffect(() => {
    let cancelled = false

    const applyPendingWorkflow = (cfg: QAppCfg | null) => {
      if (!pendingWorkflowRef.current || !fillParamsFromWorkflowRef.current || !cfg) {
        return
      }

      const pendingWorkflow = pendingWorkflowRef.current
      setTimeout(() => {
        if (cancelled) {
          return
        }
        fillParamsFromWorkflowRef.current?.(pendingWorkflow, cfg)
        if (pendingWorkflowRef.current === pendingWorkflow) {
          pendingWorkflowRef.current = null
        }
      }, 100)
    }

    if (!qAppKey) {
      setQAppCfg(null)
      setWorkflow(null)
      setFormState(new Map())
      return
    }

    const cached = qAppCache.get(qAppKey)
    const hasCachedSnapshot = Boolean(cached?.cfg && cached?.workflow)

    setIsLoading(!hasCachedSnapshot)
    if (cached?.formState) {
      setFormState(new Map(cached.formState))
    }
    if (cached?.cfg) {
      setQAppCfg(cached.cfg)
    }
    if (cached?.workflow) {
      setWorkflow(cached.workflow)
    }
    applyPendingWorkflow(cached?.cfg ?? null)

    if (skipServerFetch) {
      setIsLoading(false)
      return
    }

    const fetchQAppCfg = async () => {
      try {
        let resCfg: QAppCfg
        let resWorkflow: Workflow

        if (qAppKey.startsWith('~remote/')) {
          const { fetchRemoteQAppCfg } = await import('@renderer/utils/remoteQApp')
          const stateResp = await api().svcState.getConfig({})
          const serverOrigin = stateResp.config.remote_llm_server_config?.server_origin
          if (!serverOrigin) {
            throw new Error('未配置远程 LLM 服务器地址')
          }
          const remoteRes = await fetchRemoteQAppCfg(serverOrigin, qAppKey, stateResp.config)
          resCfg = remoteRes.cfg
          resWorkflow = remoteRes.workflow
        } else {
          const res = await api().svcQApp.getQAppCfg({ key: qAppKey })
          resCfg = res.cfg
          resWorkflow = res.workflow
        }

        if (cancelled) {
          return
        }

        setQAppCfg(resCfg)
        setWorkflow(resWorkflow)
        const cachedAfter = qAppCache.get(qAppKey)
        if (cachedAfter?.formState) {
          setFormState(new Map(cachedAfter.formState))
        }
        applyPendingWorkflow(resCfg)
      } catch (error) {
        if (cancelled) {
          return
        }
        console.error('fetchQAppCfg', error)
        notifyError('获取 QApp 配置失败')
        if (!cached?.cfg) {
          setQAppCfg(null)
        }
        if (!cached?.workflow) {
          setWorkflow(null)
        }
        const cachedAfter = qAppCache.get(qAppKey)
        if (cachedAfter?.formState) {
          setFormState(new Map(cachedAfter.formState))
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
          // Fresh data has been loaded (or load failed), allow cache
          // writeback again so subsequent user edits are persisted.
          cacheWriteBlockedRef.current = false
        }
      }
    }

    fetchQAppCfg()

    return () => {
      cancelled = true
    }
  }, [qAppKey, skipServerFetch, notifyError, cacheInvalidationTick])

  useEffect(() => {
    if (!qAppKey) {
      return
    }
    // Skip cache writeback while an invalidation→refetch cycle is in progress.
    // Without this guard, the stale state (which hasn't been flushed yet by
    // React) would be written right back into the cache, defeating the
    // invalidation.
    if (cacheWriteBlockedRef.current) {
      return
    }
    const prev = qAppCache.get(qAppKey)
    qAppCache.set(qAppKey, {
      cfg: qAppCfg ?? prev?.cfg ?? null,
      workflow: workflow ?? prev?.workflow ?? null,
      formState: new Map(formState)
    })
  }, [qAppKey, qAppCfg, workflow, formState])

  const setValidateFn = useCallback((next: (() => boolean) | undefined) => {
    setValidateInternal(() => next)
  }, [])

  const setBuildWorkflowFn = useCallback((next: (() => Workflow) | undefined) => {
    setBuildWorkflowInternal(() => next)
  }, [])

  const setBuildSubmitExtraDataFn = useCallback(
    (next: (() => JsonDict | undefined) | undefined) => {
      setBuildSubmitExtraDataInternal(() => next)
    },
    []
  )

  const setSubmitClientIdFn = useCallback((next: string | undefined) => {
    setSubmitClientIdInternal(String(next || '').trim() || undefined)
  }, [])

  const setSubmitSessionKeyFn = useCallback((next: string | undefined) => {
    setSubmitSessionKeyInternal(String(next || '').trim() || undefined)
  }, [])

  // 监听填充参数事件
  useEffect(() => {
    const handleFillParams = (event: CustomEvent<{ workflow: Workflow }>) => {
      if (qAppCfg && fillParamsFromWorkflowRef.current) {
        // 如果qAppCfg已经加载，直接填充
        setTimeout(() => {
          fillParamsFromWorkflowRef.current?.(event.detail.workflow, qAppCfg)
        }, 100)
      } else {
        // 如果qAppCfg还没加载，保存工作流等待加载完成
        pendingWorkflowRef.current = event.detail.workflow
      }
    }

    window.addEventListener('qapp:fillParams', handleFillParams as EventListener)
    return () => {
      window.removeEventListener('qapp:fillParams', handleFillParams as EventListener)
    }
  }, [qAppCfg])

  useEffect(() => {
    const handleApplyTaskPack = (event: Event) => {
      const detail = (event as CustomEvent<QAppApplyTaskPackDetail>).detail
      if (!detail?.qAppKey || detail.qAppKey !== qAppKey) {
        return
      }

      pendingTaskPackRef.current = detail

      if (qAppCfg) {
        void applyTaskPackToInputs(detail, qAppCfg)
      }
    }

    window.addEventListener(QAPP_APPLY_TASK_PACK_EVENT, handleApplyTaskPack as EventListener)
    return () => {
      window.removeEventListener(QAPP_APPLY_TASK_PACK_EVENT, handleApplyTaskPack as EventListener)
    }
  }, [applyTaskPackToInputs, qAppCfg, qAppKey])

  useEffect(() => {
    if (!qAppKey || !qAppCfg) {
      return
    }

    const pending = pendingTaskPackRef.current ?? readPendingQAppTaskPack(qAppKey)
    if (!pending || pending.qAppKey !== qAppKey) {
      return
    }

    pendingTaskPackRef.current = pending
    void applyTaskPackToInputs(pending, qAppCfg)
  }, [applyTaskPackToInputs, qAppCfg, qAppKey])

  return (
    <QAppContext.Provider
      value={{
        qAppCfg,
        workflow,
        setQAppCfg,
        setWorkflow,
        submitClientId,
        submitSessionKey,
        validate,
        buildWorkflow,
        buildSubmitExtraData,
        setSubmitClientId: setSubmitClientIdFn,
        setSubmitSessionKey: setSubmitSessionKeyFn,
        setValidate: setValidateFn,
        setBuildWorkflow: setBuildWorkflowFn,
        setBuildSubmitExtraData: setBuildSubmitExtraDataFn,
        formState,
        setFormStateValue,
        currentQAppKey: qAppKey,
        isLoading
      }}
    >
      {children}
    </QAppContext.Provider>
  )
}

export const useQAppContext = (): QAppContextType => useContext(QAppContext)

export const useQAppInputState = <T,>(
  formKey: string,
  defaultValue: T
): [T, (value: T) => void] => {
  const { formState, setFormStateValue } = useQAppContext()

  const storedValue = useMemo(() => {
    return formState.get(formKey) as T | undefined
  }, [formState, formKey])

  // 初始化时优先使用 storedValue，如果不存在则使用 defaultValue
  const [value, setValue] = useState<T>(() =>
    storedValue !== undefined ? storedValue : defaultValue
  )

  // 使用 ref 来读取当前 value，避免将 value 放入依赖数组导致循环
  const valueRef = useRef<T>(value)
  valueRef.current = value

  // 使用 ref 来跟踪上一次的 storedValue，避免不必要的更新
  const prevStoredValueRef = useRef<T | undefined>(storedValue)
  const prevDefaultValueRef = useRef<T>(defaultValue)
  const prevFormKeyRef = useRef(formKey)

  // 仅在 storedValue 变化时同步到本地 value（外部 → 本地）
  useEffect(() => {
    // 如果 storedValue 与上一次不同，需要更新
    if (!qAppInputValueEquals(storedValue, prevStoredValueRef.current)) {
      prevStoredValueRef.current = storedValue
      if (storedValue !== undefined) {
        // storedValue 有值，更新本地 value
        if (!qAppInputValueEquals(storedValue, valueRef.current)) {
          setValue(storedValue)
        }
      } else {
        // storedValue 变为 undefined，重置为 defaultValue
        if (!qAppInputValueEquals(valueRef.current, defaultValue)) {
          setValue(defaultValue)
          setFormStateValue(formKey, defaultValue)
        }
      }
    }
  }, [storedValue, defaultValue, formKey, setFormStateValue])

  useEffect(() => {
    const defaultValueChanged = !qAppInputValueEquals(defaultValue, prevDefaultValueRef.current)
    const formKeyChanged = formKey !== prevFormKeyRef.current

    if (!defaultValueChanged && !formKeyChanged) {
      return
    }

    prevDefaultValueRef.current = defaultValue
    prevFormKeyRef.current = formKey

    if (storedValue !== undefined) {
      if (!qAppInputValueEquals(storedValue, valueRef.current) || formKeyChanged) {
        setValue(storedValue)
      }
      return
    }

    if (!qAppInputValueEquals(valueRef.current, defaultValue) || formKeyChanged) {
      setValue(defaultValue)
    }
    setFormStateValue(formKey, defaultValue)
  }, [storedValue, defaultValue, formKey, setFormStateValue])

  const updateValue = useCallback(
    (next: T) => {
      setValue((prev) => (qAppInputValueEquals(prev, next) ? prev : next))
      setFormStateValue(formKey, next)
    },
    [formKey, setFormStateValue]
  )

  return [value, updateValue]
}

// ─── 获取和恢复全局缓存（用于保存/打开工程画布） ───
export const getGlobalQAppCache = () => {
  const cacheObj: Record<string, unknown> = {}
  qAppCache.forEach((value, key) => {
    cacheObj[key] = {
      cfg: value.cfg,
      workflow: value.workflow,
      formState: Object.fromEntries(value.formState.entries())
    }
  })
  return cacheObj
}

export const restoreGlobalQAppCache = (cacheObj: Record<string, unknown>) => {
  if (!cacheObj) return
  Object.keys(cacheObj).forEach((key) => {
    const val = cacheObj[key] as any
    qAppCache.set(key, {
      cfg: val.cfg,
      workflow: val.workflow,
      formState: new Map(Object.entries(val.formState || {}))
    })
  })
}

export const clearCachedQAppState = (qAppKey?: string) => {
  if (qAppKey === undefined) {
    qAppCache.clear()
    return
  }

  qAppCache.delete(qAppKey)
  // Notify any mounted QAppContextProvider that watches this key to force re-fetch
  window.dispatchEvent(new CustomEvent('qapp:cache-invalidated', { detail: { key: qAppKey } }))
}

export const renameCachedQAppState = (fromKey: string, toKey: string) => {
  if (!fromKey || !toKey || fromKey === toKey) {
    return
  }

  const cached = qAppCache.get(fromKey)
  if (cached) {
    qAppCache.set(toKey, cloneQAppCacheEntry(cached))
  } else {
    qAppCache.delete(toKey)
  }

  qAppCache.delete(fromKey)
}
