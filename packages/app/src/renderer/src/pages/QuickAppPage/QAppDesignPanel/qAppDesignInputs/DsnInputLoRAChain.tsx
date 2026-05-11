import { useCallback, useEffect, useState } from 'react'
import { QAppDesignComponent, QAppDesignProps } from './types'
import DsnComponentLayout from './components/DsnComponentLayout'
import { useInputLabel } from './components/InputLabel'
import InputNodeSelect from './components/InputNodeSelect'
import { Alert, Typography } from '@mui/material'
import { conditionNodeLoRALoader } from './conditions'
import { getJsonPath, JsonPath } from '@shared/utils/jsonPath'
import {
  ObjectInfo,
  ObjectInfoMap,
  Workflow,
  WorkflowInputRef,
  WorkflowNode
} from '@shared/comfy/types'
import {
  fieldByJsonPath,
  nodeIdAndClsByJsonPath,
  parseAllNodeIdAndField
} from '@shared/comfy/funcs'
import { QAppCfgInputLoRAChain } from '@shared/qApp/cfgTypes'

type LoRAChain = {
  outputModelSlots: JsonPath[]
  outputClipSlots: JsonPath[]
  inputModel: [string, number]
  inputClip: [string, number]
}

/**
 * 根据输入的 slot ，计算出整条 LoRA 链的信息，用于自动生成 LoRA 链的配置
 * @param slot the json path of the LoRA chain node
 * @param workflow the workflow
 * @param objInfos the object infos
 * @returns the output model slots, the output clip slots, the input model, the input clip
 */
const calculateLoRAChain = (
  slot: JsonPath,
  workflow: Workflow,
  objInfos: ObjectInfoMap
): LoRAChain => {
  const dummy: LoRAChain = {
    outputModelSlots: [],
    outputClipSlots: [],
    inputModel: ['', 0],
    inputClip: ['', 0]
  }
  const [nodeId] = nodeIdAndClsByJsonPath(slot, workflow)
  const node = workflow[nodeId]
  if (!node) {
    return dummy
  }

  type NodeIdAndNode = { nodeId: string; node: WorkflowNode }

  // return [model, clip]
  const getInputRef = ({
    nodeId,
    node
  }: NodeIdAndNode): [WorkflowInputRef, WorkflowInputRef] | null => {
    const inputModelRef = node.inputs.model
    if (!inputModelRef || !Array.isArray(inputModelRef)) {
      return null
    }
    const inputClipRef = node.inputs.clip
    if (!inputClipRef || !Array.isArray(inputClipRef)) {
      return null
    }
    return [inputModelRef, inputClipRef]
  }

  const prevNode = ({ nodeId, node }: NodeIdAndNode): NodeIdAndNode | null => {
    if (!node) {
      return null
    }
    const inputRefs = getInputRef({ nodeId, node })
    if (!inputRefs) {
      return null
    }
    const [inputModelRef, inputClipRef] = inputRefs
    if (inputModelRef[0] !== inputClipRef[0]) {
      // LoRA 链只允许处理单个节点提供 Model 和 Clip 的情况
      return null
    }
    const inputNodeId = inputModelRef[0]
    const inputNode = workflow[inputNodeId]
    if (!inputNode) {
      return null
    }
    const inputNodeObjInfo = objInfos[inputNode.class_type]
    if (!inputNodeObjInfo) {
      return null
    }
    const inputNodeIsLoRALoader = conditionNodeLoRALoader(inputNodeObjInfo)
    if (!inputNodeIsLoRALoader) {
      return null
    }
    return { nodeId: inputNodeId, node: inputNode }
  }

  type BackRef = {
    providerNodeId: string
    providerOutputIndex: number
    consumerNodeId: string
    consumerFieldName: string
  }

  const backRefs: BackRef[] = parseAllNodeIdAndField(workflow)
    .map(({ nodeId, field }): BackRef | null => {
      const node = workflow[nodeId]
      if (!node) {
        return null
      }
      const fieldValue = node.inputs?.[field]
      if (!fieldValue || !Array.isArray(fieldValue)) {
        return null
      }
      if (fieldValue.length !== 2) {
        return null
      }
      return {
        providerNodeId: fieldValue[0],
        providerOutputIndex: fieldValue[1],
        consumerNodeId: nodeId,
        consumerFieldName: field
      }
    })
    .filter((input) => input !== null)

  // return [model, clip]
  const getOutputBackRefs = ({ nodeId, node }: NodeIdAndNode): [BackRef[], BackRef[]] => {
    const outputModelRefs = backRefs.filter(
      (backRef) => backRef.providerNodeId === nodeId && backRef.providerOutputIndex === 0
    )
    const outputClipRefs = backRefs.filter(
      (backRef) => backRef.providerNodeId === nodeId && backRef.providerOutputIndex === 1
    )
    return [outputModelRefs, outputClipRefs]
  }

  const nextNode = ({ nodeId, node }: NodeIdAndNode): NodeIdAndNode | null => {
    const [outputModelRefs, outputClipRefs] = getOutputBackRefs({ nodeId, node })
    if (outputModelRefs.length !== 1 || outputClipRefs.length !== 1) {
      // LoRA 链只允许处理单个节点接受 Model 和 Clip 的情况
      return null
    }
    const outputModelRef = outputModelRefs[0]
    const outputClipRef = outputClipRefs[0]

    if (outputModelRef.consumerNodeId !== outputClipRef.consumerNodeId) {
      // LoRA 链只允许处理单个节点接受 Model 和 Clip 的情况
      return null
    }
    const consumerNodeId = outputModelRef.consumerNodeId
    const consumerNode = workflow[consumerNodeId]
    if (!consumerNode) {
      return null
    }
    const consumerNodeObjInfo = objInfos[consumerNode.class_type]
    if (!consumerNodeObjInfo) {
      return null
    }
    const consumerNodeIsLoRALoader = conditionNodeLoRALoader(consumerNodeObjInfo)
    if (!consumerNodeIsLoRALoader) {
      return null
    }
    return {
      nodeId: consumerNodeId,
      node: consumerNode
    }
  }

  // 找到 LoRA 链的头部, head 依然是一个 LoRALoader
  let head: NodeIdAndNode | null = { nodeId, node }
  while (head) {
    const current = prevNode(head)
    if (!current) {
      break
    }
    head = current
  }

  if (!head) {
    return dummy
  }

  const inputRefs = getInputRef(head)
  if (!inputRefs) {
    return dummy
  }
  const [inputModelRef, inputClipRef] = inputRefs

  // 找到 LoRA 链的尾部, tail 依然是一个 LoRALoader
  let tail: NodeIdAndNode | null = { nodeId, node }
  while (tail) {
    const current = nextNode(tail)
    if (!current) {
      break
    }
    tail = current
  }

  if (!tail) {
    return dummy
  }

  const [outputModelRefs, outputClipRefs] = getOutputBackRefs(tail)
  const outputModelSlots = outputModelRefs.map(
    (backRef) => `$.${backRef.consumerNodeId}.inputs.${backRef.consumerFieldName}`
  )
  const outputClipSlots = outputClipRefs.map(
    (backRef) => `$.${backRef.consumerNodeId}.inputs.${backRef.consumerFieldName}`
  )

  return {
    outputModelSlots,
    outputClipSlots,
    inputModel: inputModelRef,
    inputClip: inputClipRef
  }
}

const DsnInputLoRAChain: QAppDesignComponent<'InputLoRAChain'> = ({
  workflow,
  objectInfos,
  config,
  buildEnv,
  id,
  value,
  setValue,
  onDelete
}: QAppDesignProps<'InputLoRAChain'>) => {
  const { label, InputLabel } = useInputLabel(value?.label, id, 'InputLoRAChain', onDelete)
  // 这个是 Workflow 中的一个 LoRA 节点, 从这个节点推算出 LoRA 链
  const [nodeSlot, setNodeSlot] = useState<string | null>(() => {
    // 取默认值：从 outputModelSlot 拿到 LoRA 链最后的节点
    const outputModelSlot = value?.outputModelSlots?.length && value?.outputModelSlots[0]
    if (!outputModelSlot) {
      return null
    }
    const modelSlotValue = getJsonPath(outputModelSlot, workflow)
    if (
      !modelSlotValue ||
      !Array.isArray(modelSlotValue) ||
      modelSlotValue.length !== 2 ||
      typeof modelSlotValue[0] !== 'string'
    ) {
      return null
    }
    const modelSlotValueNodeId = modelSlotValue[0]
    if (!modelSlotValueNodeId) {
      return null
    }
    return `$.${modelSlotValueNodeId}`
  })
  const [outputModelSlots, setOutputModelSlots] = useState<string[]>(value?.outputModelSlots || [])
  const [outputClipSlots, setOutputClipSlots] = useState<string[]>(value?.outputClipSlots || [])
  const [inputModel, setInputModel] = useState<[string, number]>(value?.inputModel || ['', 0])
  const [inputClip, setInputClip] = useState<[string, number]>(value?.inputClip || ['', 0])

  useEffect(() => {
    if (!inputModel[0] || !inputClip[0]) {
      return
    }
    setValue({
      label,
      component: 'InputLoRAChain',
      outputModelSlots,
      outputClipSlots,
      inputModel,
      inputClip
    } satisfies QAppCfgInputLoRAChain)
  }, [label, outputModelSlots, outputClipSlots, inputModel, inputClip, setValue])

  useEffect(() => {
    if (nodeSlot) {
      const loRAChain = calculateLoRAChain(nodeSlot, workflow, objectInfos)
      setOutputModelSlots(loRAChain.outputModelSlots)
      setOutputClipSlots(loRAChain.outputClipSlots)
      setInputModel(loRAChain.inputModel)
      setInputClip(loRAChain.inputClip)
    } else {
      setOutputModelSlots([])
      setOutputClipSlots([])
      setInputModel(['', 0])
      setInputClip(['', 0])
    }
  }, [nodeSlot, workflow, objectInfos])

  const [outputModelSlotsDisplay, setOutputModelSlotsDisplay] = useState<string[]>([])
  const [outputClipSlotsDisplay, setOutputClipSlotsDisplay] = useState<string[]>([])
  const [inputModelDisplay, setInputModelDisplay] = useState<string>('')
  const [inputClipDisplay, setInputClipDisplay] = useState<string>('')

  const slotToDisplay = useCallback(
    (slot: JsonPath) => {
      const [nodeId, cls] = nodeIdAndClsByJsonPath(slot, workflow)
      const node = workflow[nodeId]
      if (!node) {
        return ''
      }
      const nodeName = node._meta?.title
        ? `${node._meta?.title} (#${nodeId})`
        : `${cls} (#${nodeId})`

      const field = fieldByJsonPath(slot, workflow)
      return `${nodeName} ${field} 字段`
    },
    [workflow]
  )
  const refToDisplay = useCallback(
    (ref: WorkflowInputRef) => {
      const [nodeId, outIndex] = ref
      const node = workflow[nodeId]
      if (!node) {
        return ''
      }
      const nodeName = node._meta?.title
        ? `${node._meta?.title} (#${nodeId})`
        : `${node.class_type} (#${nodeId})`
      return `${nodeName} 输出 ${outIndex}`
    },
    [workflow]
  )

  useEffect(() => {
    setOutputModelSlotsDisplay(outputModelSlots.map(slotToDisplay))
  }, [outputModelSlots, slotToDisplay])
  useEffect(() => {
    setOutputClipSlotsDisplay(outputClipSlots.map(slotToDisplay))
  }, [outputClipSlots, slotToDisplay])
  useEffect(() => {
    setInputModelDisplay(refToDisplay(inputModel))
  }, [inputModel, refToDisplay])
  useEffect(() => {
    setInputClipDisplay(refToDisplay(inputClip))
  }, [inputClip, refToDisplay])

  return (
    <DsnComponentLayout>
      <InputLabel />
      <InputNodeSelect
        label="选择一个LoRA链节点"
        value={nodeSlot}
        onChange={setNodeSlot}
        workflow={workflow}
        objectInfos={objectInfos}
        mode="node"
        allowNodeCondition={conditionNodeLoRALoader}
      />
      <Alert severity="info" variant="outlined">
        这里不会固定显示 LoRA 节点。用户在执行页选择 LoRA 后，生成时才会自动创建 LoraLoader；如果
        API 流自带 LoRA，请选其中一个 LoraLoader，不选 LoRA 时会跳过原 LoRA。
      </Alert>
      {!nodeSlot && (
        <Typography variant="body1">
          请先选择一个LoRA链节点, 自动计算得出工作流中的 LoRA 链
        </Typography>
      )}
      {nodeSlot && (
        <>
          <Typography variant="h6">计算得到的接受 Model 的字段:</Typography>
          {outputModelSlotsDisplay.map((slot) => (
            <Typography variant="body1" key={slot}>
              {slot}
            </Typography>
          ))}
          <Typography variant="h6">计算得到的接受 Clip 的字段:</Typography>
          {outputClipSlotsDisplay.map((slot) => (
            <Typography variant="body1" key={slot}>
              {slot}
            </Typography>
          ))}
          <Typography variant="h6">计算得到的提供 Model 的节点:</Typography>
          <Typography variant="body1">{inputModelDisplay}</Typography>
          <Typography variant="h6">计算得到的提供 Clip 的节点:</Typography>
          <Typography variant="body1">{inputClipDisplay}</Typography>
        </>
      )}
    </DsnComponentLayout>
  )
}

DsnInputLoRAChain.displayName = 'QAppDsnLoRAChain'

export default DsnInputLoRAChain
