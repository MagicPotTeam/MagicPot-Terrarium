import React, { useEffect, useMemo, useState } from 'react'
import {
  ObjectInfo,
  ObjectInfoInputField,
  ObjectInfoMap,
  Workflow,
  WorkflowNode
} from '@shared/comfy/types'
import { JsonPath } from '@shared/utils/jsonPath'
import { Box, Typography } from '@mui/material'
import {
  fieldByJsonPath,
  nodeIdAndClsByJsonPath,
  parseAllNodeIdAndField
} from '@shared/comfy/funcs'
import InputSelect from '@renderer/components/inputs/InputSelect'
import { useMessage } from '@renderer/hooks/useMessage'
import { useTranslation } from 'react-i18next'

function nodeIdAndFieldFallback(slot: JsonPath, workflow: Workflow): [string, string] {
  let nodeId = ''
  try {
    ;[nodeId] = nodeIdAndClsByJsonPath(slot, workflow)
  } catch (error) {
    return ['', '']
  }
  const node = workflow[nodeId]
  if (!node) {
    return ['', '']
  }

  let field = ''
  try {
    field = fieldByJsonPath(slot, workflow)
  } catch (error) {
    return [nodeId, '']
  }
  return [nodeId, field]
}

type InputNodeSelectProps = {
  label: string
  value: JsonPath | null
  onChange: (value: JsonPath) => void
  workflow: Workflow
  objectInfos: ObjectInfoMap
  mode: 'node' | 'field'
  allowNodeCondition?: (objInfoNode: ObjectInfo) => boolean
  allowFieldCondition?: (objInfoNode: ObjectInfo, objInfoField: ObjectInfoInputField) => boolean
}

const InputNodeSelect: React.FC<InputNodeSelectProps> = ({
  label,
  value,
  onChange,
  workflow,
  objectInfos,
  mode,
  allowFieldCondition,
  allowNodeCondition
}) => {
  const { t } = useTranslation()
  const { notifyWarning } = useMessage()
  const [defaultNodeId, defaultField] = useMemo(
    () => (value ? nodeIdAndFieldFallback(value, workflow) : ['', '']),
    [value, workflow]
  )

  // 所有允许的字段（用于字段选项）
  const allAllowedNodeIdAndField = useMemo(() => {
    const allNodeIdAndField = parseAllNodeIdAndField(workflow)
    if (!objectInfos || Object.keys(objectInfos).length === 0) {
      // 未连接到 ComfyUI 时，不提供自动筛选能力，直接展示所有节点和字段
      return allNodeIdAndField
    }
    const allNodeAndObjInfo = allNodeIdAndField
      .map(({ nodeId, field }) => {
        const node = workflow[nodeId] || null
        const objInfoNode = objectInfos?.[node?.class_type] || null
        const objInfoField =
          objInfoNode?.input?.required?.[field] || objInfoNode?.input?.optional?.[field] || null
        return { nodeId, field, node, objInfoNode, objInfoField }
      })
      .filter(({ node }) => node !== null)

    const filtered = allNodeAndObjInfo
      .filter(({ objInfoNode }) => {
        if (!allowNodeCondition) {
          return true
        }
        if (!objInfoNode) {
          return true // 保留未能解析的节点，以便用户手动选择
        }
        return allowNodeCondition(objInfoNode)
      })
      .filter(({ objInfoNode, objInfoField }) => {
        if (!allowFieldCondition) {
          return true
        }
        if (!objInfoNode || !objInfoField) {
          return true // 保留未能解析的节点，以便用户手动选择
        }
        return allowFieldCondition(objInfoNode, objInfoField)
      })

    return filtered.map(({ nodeId, field }) => ({ nodeId, field }))
  }, [workflow, allowFieldCondition, objectInfos, allowNodeCondition])

  // 所有允许的节点（用于节点选项，应该包含所有存在的节点，不受字段过滤影响）
  const allAllowedNodeIds = useMemo(() => {
    const allNodeIdAndField = parseAllNodeIdAndField(workflow)
    if (!objectInfos || Object.keys(objectInfos).length === 0) {
      // 未连接到 ComfyUI 时，展示所有节点
      return Array.from(new Set(allNodeIdAndField.map(({ nodeId }) => nodeId)))
    }
    const allNodeAndObjInfo: {
      nodeId: string
      field: string
      node: WorkflowNode
      objInfoNode: ObjectInfo | null
      objInfoField: ObjectInfoInputField | null
    }[] = allNodeIdAndField
      .map(({ nodeId, field }) => {
        const node = workflow[nodeId] || null
        const objInfoNode = objectInfos?.[node?.class_type] || null
        const objInfoField =
          objInfoNode?.input?.required?.[field] || objInfoNode?.input?.optional?.[field] || null
        return { nodeId, field, node, objInfoNode, objInfoField }
      })
      .filter(({ node }) => node !== null)

    // 节点过滤：只应用 allowNodeCondition，不应用 allowFieldCondition
    // 这样即使节点没有符合条件的字段，只要节点本身符合条件，就会出现在节点下拉框中
    if (allowNodeCondition) {
      const nodeIdsWithAllowedNodes = new Set(
        allNodeAndObjInfo
          .filter(({ objInfoNode }) => {
            if (!objInfoNode) {
              return true // 保留未能解析的节点，以便用户手动选择
            }
            return allowNodeCondition(objInfoNode)
          })
          .map(({ nodeId }) => nodeId)
      )
      return Array.from(nodeIdsWithAllowedNodes)
    }

    // 如果没有节点条件，返回所有有字段的节点
    return Array.from(new Set(allNodeAndObjInfo.map(({ nodeId }) => nodeId)))
  }, [workflow, objectInfos, allowNodeCondition])

  const nodeOptions: { label: string; value: string }[] = useMemo(() => {
    return allAllowedNodeIds.map((nodeId) => {
      const node = workflow[nodeId]
      if (!node) {
        return {
          label: `${nodeId} (未找到节点)`,
          value: nodeId
        }
      }
      return {
        label: node._meta?.title
          ? `${node._meta?.title} (#${nodeId})`
          : `${node.class_type} (#${nodeId})`,
        value: nodeId
      }
    })
  }, [workflow, allAllowedNodeIds])

  const [nodeId, setNodeId] = useState<string>(() => {
    if (defaultNodeId) {
      return defaultNodeId
    }
    if (nodeOptions.length > 0) {
      return nodeOptions[0].value
    }
    return ''
  })

  const fieldOptions: { label: string; value: string }[] = useMemo(() => {
    if (mode === 'node') {
      return []
    }
    const node = workflow[nodeId]
    if (!node) {
      return []
    }

    const allAllowedFieldWithNodeId = allAllowedNodeIdAndField.filter(({ nodeId: id }) => {
      return nodeId === id
    })
    if (allAllowedFieldWithNodeId.length === 0) {
      if (nodeId === defaultNodeId && defaultField && defaultField in node.inputs) {
        return [
          {
            label: defaultField,
            value: defaultField
          }
        ]
      }
      notifyWarning(`未能从 ComfyUI 获得节点 ${nodeId} 的输入字段信息`)
      return []
    }
    const fieldOptions = allAllowedFieldWithNodeId.map(({ field }) => {
      return {
        label: field,
        value: field
      }
    })
    return fieldOptions
  }, [nodeId, workflow, allAllowedNodeIdAndField, mode, notifyWarning, defaultNodeId, defaultField])

  const [field, setField] = useState<string>(() => {
    if (defaultField) {
      return defaultField
    }
    if (fieldOptions.length > 0) {
      return fieldOptions[0].value
    }
    return ''
  })

  /**
   * nodeId 更新时触发更新 field 与 value 的形式不同，是因为：
   * 1. field 是内部状态，更新时依赖到 fieldOptions ，不希望在组件加载时将默认值更新掉
   * 2. value 是外部状态，且希望在组件加载时 nodeId 获得可行默认值时直接变更掉
   */

  // nodeId 更新时触发更新 field
  const [prevNodeId, setPrevNodeId] = useState<string>(nodeId)
  if (prevNodeId !== nodeId) {
    setPrevNodeId(nodeId)
    if (mode === 'field') {
      setField((prev) => {
        if (fieldOptions.length === 0 || fieldOptions.some(({ value }) => value === prev)) {
          return prev
        }
        return fieldOptions[0].value
      })
    }
  }

  // nodeId 更新时触发更新 value
  useEffect(() => {
    if (mode === 'node' && nodeId) {
      const newValue = `$.${nodeId}`
      onChange(newValue)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, nodeId])

  // field 更新时触发更新 value
  useEffect(() => {
    if (mode === 'field' && field) {
      const newValue = `$.${nodeId}.inputs.${field}`
      onChange(newValue)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, nodeId, field])

  return (
    <Box>
      <Box sx={{ mb: 1 }}>
        <Typography variant="caption" color="text.secondary">
          {label}: {value}
        </Typography>
      </Box>
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'row',
          gap: 1
        }}
      >
        <InputSelect
          label={t('qapp.design.node')}
          value={nodeId}
          onChange={(v) => setNodeId(v)}
          items={nodeOptions}
          error={!nodeId}
        />
        {mode === 'field' && (
          <InputSelect
            label={t('qapp.design.field')}
            value={field}
            onChange={(v) => setField(v)}
            items={fieldOptions}
            error={!field}
          />
        )}
      </Box>
    </Box>
  )
}

export default InputNodeSelect
