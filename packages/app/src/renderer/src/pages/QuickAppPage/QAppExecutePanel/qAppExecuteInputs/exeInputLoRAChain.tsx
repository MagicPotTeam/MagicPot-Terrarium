import React, { useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import { setJsonPath, getJsonPath } from '@shared/utils/jsonPath'
import { ExeInputBuilder, ExeInputProps } from './types'
import InputLoRAChain, { LoRAConfig } from '@renderer/components/inputs/InputLoRAChain'
import { findFieldOptions } from '@shared/comfy/funcs'
import { useQAppContext, useQAppInputState } from '../../components/QAppContext'
import { WorkflowInputRef, Workflow } from '@shared/comfy/types'
import { ConfigUtils } from '@shared/config/configUtils'
import {
  appendPromptTriggerWords,
  normalizeTriggerWords,
  readLoraTriggerWordsMap,
  updateLoraTriggerWordsMap,
  writeLoraTriggerWordsMap
} from '@renderer/components/inputs/loraTriggerWords'
import {
  listLoraModelOptions,
  readLoraTriggerWordsSidecar
} from '@renderer/components/inputs/loraTriggerWordFiles'

const keyLoraLoader = 'LoraLoader'

const isNegativePromptLabel = (label: string): boolean =>
  /negative|\u8d1f\u9762|\u53cd\u5411|\u4e0d\u8981|\u6392\u9664/i.test(label)

const buildExeInputLoRAChain: ExeInputBuilder<'InputLoRAChain'> = (cfg, workflow) => {
  const { label, outputModelSlots, outputClipSlots, inputModel, inputClip } = cfg

  const id = `QAppInputLoRAChain-${label}`

  const formKey = `${label}-${outputModelSlots.join('|')}-${outputClipSlots.join('|')}`

  const QAppInputLoRAChain: React.FC<ExeInputProps> = ({ objectInfos, config, buildEnv, ref }) => {
    const configUtils = useMemo(
      () => new ConfigUtils(config, buildEnv, window.path),
      [buildEnv, config]
    )
    const objectInfoOptions = findFieldOptions(objectInfos, keyLoraLoader, 'lora_name')
    const [fallbackOptions, setFallbackOptions] = useState<string[]>([])
    const options = objectInfoOptions.length > 0 ? objectInfoOptions : fallbackOptions
    const [loraInputs, setLoraInputs] = useQAppInputState<LoRAConfig[]>(formKey, [])
    const { qAppCfg, formState, setFormStateValue } = useQAppContext()

    useEffect(() => {
      if (objectInfoOptions.length > 0) {
        return
      }

      let cancelled = false
      void listLoraModelOptions(configUtils).then((modelOptions) => {
        if (!cancelled) {
          setFallbackOptions(modelOptions)
        }
      })

      return () => {
        cancelled = true
      }
    }, [configUtils, objectInfoOptions.length])

    const primaryPromptSlot = useMemo(() => {
      const promptInputs = qAppCfg?.inputs.filter((input) => input.component === 'InputPrompt')
      const primaryPromptInput =
        promptInputs?.find((input) => !isNegativePromptLabel(input.label)) ?? promptInputs?.[0]
      return primaryPromptInput?.slot
    }, [qAppCfg])

    const appendLoraTriggerWordsToPrompt = useCallback(
      async (loraName: string, preferredTriggerWords?: string) => {
        let triggerWords = normalizeTriggerWords(
          preferredTriggerWords || readLoraTriggerWordsMap()[loraName] || ''
        )
        if (!triggerWords) {
          triggerWords = await readLoraTriggerWordsSidecar(loraName, configUtils)
        }
        if (!triggerWords) {
          return
        }

        writeLoraTriggerWordsMap(
          updateLoraTriggerWordsMap(readLoraTriggerWordsMap(), loraName, triggerWords)
        )

        if (!primaryPromptSlot) {
          return triggerWords
        }

        const storedPrompt = formState.get(primaryPromptSlot)
        let currentPrompt = typeof storedPrompt === 'string' ? storedPrompt : ''
        if (!currentPrompt) {
          try {
            const defaultPrompt = getJsonPath(primaryPromptSlot, workflow)
            currentPrompt = typeof defaultPrompt === 'string' ? defaultPrompt : ''
          } catch {
            currentPrompt = ''
          }
        }

        const nextPrompt = appendPromptTriggerWords(currentPrompt, triggerWords)
        if (nextPrompt !== currentPrompt) {
          setFormStateValue(primaryPromptSlot, nextPrompt)
        }

        return triggerWords
      },
      [configUtils, formState, primaryPromptSlot, setFormStateValue]
    )

    useImperativeHandle(
      ref,
      () => ({
        id,
        modifyWorkflow: (workflow) => {
          // 过滤出有效的 LoRA（lora_name 不为空）
          const validLoraInputs = loraInputs.filter(
            (lora) => lora.lora_name && lora.lora_name.trim() !== ''
          )

          // 如果用户没有输入任何有效的 LoRA，跳过硬编码的 LoRA 链，直接使用源节点
          if (validLoraInputs.length === 0) {
            // 递归查找 LoRA 链的头部（源节点），并收集路径上的所有 LoRA 节点
            // field 参数指定要查找的字段：'model' 或 'clip'
            const findSourceNodeAndCollectLoraNodes = (
              nodeRef: WorkflowInputRef,
              field: 'model' | 'clip',
              loraNodes: Set<string> = new Set()
            ): { sourceNode: WorkflowInputRef; loraNodes: Set<string> } => {
              if (
                !Array.isArray(nodeRef) ||
                nodeRef.length !== 2 ||
                typeof nodeRef[0] !== 'string'
              ) {
                return { sourceNode: nodeRef, loraNodes }
              }
              const nodeId = nodeRef[0]
              const node = workflow[nodeId]
              if (node && node.class_type === keyLoraLoader) {
                // 收集这个 LoRA 节点
                loraNodes.add(nodeId)
                // 如果当前节点是 LoRA 节点，继续向上查找指定字段的输入
                const fieldInput = node.inputs?.[field]
                if (Array.isArray(fieldInput) && fieldInput.length === 2) {
                  return findSourceNodeAndCollectLoraNodes(
                    fieldInput as WorkflowInputRef,
                    field,
                    loraNodes
                  )
                }
              }
              return { sourceNode: nodeRef, loraNodes }
            }

            // 从 inputModel 和 inputClip 开始，递归查找源节点并收集 LoRA 节点
            const { sourceNode: sourceModel, loraNodes: modelLoraNodes } =
              findSourceNodeAndCollectLoraNodes(inputModel, 'model')
            const { sourceNode: sourceClip, loraNodes: clipLoraNodes } =
              findSourceNodeAndCollectLoraNodes(inputClip, 'clip')

            // 从给定节点引用开始，沿着输入向上查找所有 LoRA 节点
            const findLoraNodesOnPathUp = (
              nodeRef: WorkflowInputRef,
              field: 'model' | 'clip',
              visited: Set<string> = new Set()
            ): Set<string> => {
              const loraNodes = new Set<string>()
              if (
                !Array.isArray(nodeRef) ||
                nodeRef.length !== 2 ||
                typeof nodeRef[0] !== 'string'
              ) {
                return loraNodes
              }
              const nodeId = nodeRef[0]
              // 避免循环引用
              if (visited.has(nodeId)) {
                return loraNodes
              }
              visited.add(nodeId)

              const node = workflow[nodeId]
              if (node && node.class_type === keyLoraLoader) {
                loraNodes.add(nodeId)
                // 继续向上查找（通过 model 或 clip 输入）
                const fieldInput = node.inputs?.[field]
                if (Array.isArray(fieldInput) && fieldInput.length === 2) {
                  findLoraNodesOnPathUp(fieldInput as WorkflowInputRef, field, visited).forEach(
                    (id) => loraNodes.add(id)
                  )
                }
              }
              return loraNodes
            }

            // 从原始输出节点开始，沿着输入向上查找路径上的 LoRA 节点
            // 需要在修改输出连接之前获取原始连接值
            const outputLoraNodes = new Set<string>()
            for (const outputSlot of outputModelSlots) {
              try {
                const originalOutputRef = getJsonPath(outputSlot, workflow)
                if (
                  originalOutputRef &&
                  Array.isArray(originalOutputRef) &&
                  originalOutputRef.length === 2
                ) {
                  const nodes = findLoraNodesOnPathUp(
                    originalOutputRef as WorkflowInputRef,
                    'model'
                  )
                  nodes.forEach((id) => outputLoraNodes.add(id))
                }
              } catch (e) {
                // 忽略错误
              }
            }
            for (const outputSlot of outputClipSlots) {
              try {
                const originalOutputRef = getJsonPath(outputSlot, workflow)
                if (
                  originalOutputRef &&
                  Array.isArray(originalOutputRef) &&
                  originalOutputRef.length === 2
                ) {
                  const nodes = findLoraNodesOnPathUp(originalOutputRef as WorkflowInputRef, 'clip')
                  nodes.forEach((id) => outputLoraNodes.add(id))
                }
              } catch (e) {
                // 忽略错误
              }
            }

            // 合并所有 LoRA 节点（包括 model 和 clip 路径上的，以及输出路径上的）
            const allLoraNodes = new Set([...modelLoraNodes, ...clipLoraNodes, ...outputLoraNodes])

            // 禁用所有硬编码的 LoRA 节点，将 lora_name 设置为空字符串
            // 这样它们就不会尝试加载不存在的 LoRA 文件
            for (const nodeId of allLoraNodes) {
              const node = workflow[nodeId]
              if (node && node.class_type === keyLoraLoader && node.inputs) {
                node.inputs.lora_name = ''
                node.inputs.strength_model = 0
                node.inputs.strength_clip = 0
              }
            }

            // 直接使用源节点作为输出，跳过硬编码的 LoRA 链
            for (let i = 0; i < outputModelSlots.length; i++) {
              setJsonPath(outputModelSlots[i], workflow, sourceModel)
            }
            for (let i = 0; i < outputClipSlots.length; i++) {
              setJsonPath(outputClipSlots[i], workflow, sourceClip)
            }
            return
          }

          // 如果用户输入了有效的 LoRA，正常创建 LoRA 节点链
          let currentModel = inputModel
          let currentClip = inputClip
          let nodeIndex = 0
          for (let i = 0; i < loraInputs.length; i++) {
            const currentLoraInput = loraInputs[i]
            // 跳过名称为空的 LoRA
            if (!currentLoraInput.lora_name || currentLoraInput.lora_name.trim() === '') {
              continue
            }
            const currentNodeId = `${id}_${nodeIndex}`
            workflow[currentNodeId] = {
              class_type: keyLoraLoader,
              inputs: {
                lora_name: currentLoraInput.lora_name,
                strength_model: currentLoraInput.strength_model,
                strength_clip: currentLoraInput.strength_clip,
                model: currentModel,
                clip: currentClip
              }
            }
            currentModel = [currentNodeId, 0]
            currentClip = [currentNodeId, 1]
            nodeIndex += 1
          }

          for (let i = 0; i < outputModelSlots.length; i++) {
            setJsonPath(outputModelSlots[i], workflow, currentModel)
          }
          for (let i = 0; i < outputClipSlots.length; i++) {
            setJsonPath(outputClipSlots[i], workflow, currentClip)
          }
        },
        validate: (workflow) => '' //只要配置无误，一定合法
      }),
      [loraInputs]
    )

    return (
      <InputLoRAChain
        label={label}
        value={loraInputs}
        onChange={(v) => setLoraInputs(v)}
        lora_options={options}
        onLoraSelected={appendLoraTriggerWordsToPrompt}
      />
    )
  }

  QAppInputLoRAChain.displayName = id
  return QAppInputLoRAChain
}

export default buildExeInputLoRAChain
