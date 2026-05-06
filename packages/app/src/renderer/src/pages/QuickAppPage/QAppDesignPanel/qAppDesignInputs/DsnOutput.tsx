import React from 'react'
import { ObjectInfoMap, Workflow } from '@shared/comfy/types'
import InputNodeSelect from './components/InputNodeSelect'
import { useCallback, useEffect, useState, memo } from 'react'
import { Alert, Box, Button, IconButton, Stack } from '@mui/material'
import { AddOutlined, Delete } from '@mui/icons-material'
import InputSwitch from '@renderer/components/inputs/InputSwitch'
import DsnComponentLayout from './components/DsnComponentLayout'
import { conditionNodeIsOutputNode } from './conditions'
import { useTranslation } from 'react-i18next'

type NodeSlotWithId = {
  id: string
  nodeSlot: string
}

type NodeSlotItemProps = {
  nodeSlot: NodeSlotWithId
  workflow: Workflow
  objectInfos: ObjectInfoMap
  onNodeSlotChange: (id: string, newNodeSlot: string) => void
  onRemove: (id: string) => void
}

// 独立的 NodeSlotItem 组件，避免 onChange 函数引用变化
const NodeSlotItem = memo<NodeSlotItemProps>(
  ({ nodeSlot, workflow, objectInfos, onNodeSlotChange, onRemove }: NodeSlotItemProps) => {
    const { t } = useTranslation()
    const handleChange = useCallback(
      (newNodeSlot: string) => {
        onNodeSlotChange(nodeSlot.id, newNodeSlot)
      },
      [nodeSlot.id, onNodeSlotChange]
    )

    const handleRemove = useCallback(() => {
      onRemove(nodeSlot.id)
    }, [nodeSlot.id, onRemove])

    return (
      <Box sx={{ display: 'flex', flexDirection: 'row', gap: 1, alignItems: 'flex-end' }}>
        <Box sx={{ flex: 1 }}>
          <InputNodeSelect
            label={t('qapp.design.output_node')}
            value={nodeSlot.nodeSlot}
            onChange={handleChange}
            workflow={workflow}
            objectInfos={objectInfos}
            mode="node"
            allowNodeCondition={conditionNodeIsOutputNode}
          />
        </Box>
        <Box>
          <IconButton size="large" onClick={handleRemove}>
            <Delete />
          </IconButton>
        </Box>
      </Box>
    )
  }
)

NodeSlotItem.displayName = 'NodeSlotItem'

type DsnOutputProps = {
  workflow: Workflow
  objectInfos: ObjectInfoMap
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  value: string[]
  setValue: (value: string[]) => void
}

const DsnOutput = ({
  workflow,
  objectInfos,
  value,
  setValue,
  enabled,
  setEnabled
}: DsnOutputProps) => {
  const { t } = useTranslation()
  const [nodeSlots, setNodeSlots] = useState<NodeSlotWithId[]>(() => {
    return (value || []).map((nodeSlot) => ({
      id: crypto.randomUUID(),
      nodeSlot: `$.${nodeSlot}`
    }))
  })

  // nodeSlots 更新时触发 setValue
  useEffect(() => {
    console.log('nodeSlots', nodeSlots)
    setValue(nodeSlots.map((nodeSlot) => nodeSlot.nodeSlot.split('$.')[1]))
  }, [nodeSlots, setValue])

  const addNodeSlot = useCallback((nodeSlot: string) => {
    console.log('addNodeSlot', nodeSlot)
    setNodeSlots((prev) => [...prev, { id: crypto.randomUUID(), nodeSlot: `$.${nodeSlot}` }])
  }, [])
  const removeNodeSlot = useCallback((id: string) => {
    console.log('removeNodeSlot', id)
    setNodeSlots((prev) => prev.filter((nodeSlot) => nodeSlot.id !== id))
  }, [])
  const setNodeSlot = useCallback((id: string, newNodeSlot: string) => {
    console.log('setNodeSlot', id, newNodeSlot)
    setNodeSlots((prev) =>
      prev.map((nodeSlot) =>
        nodeSlot.id === id ? { ...nodeSlot, nodeSlot: newNodeSlot } : nodeSlot
      )
    )
  }, [])

  return (
    <>
      <InputSwitch
        label={t('qapp.design.set_output_node_ids')}
        value={enabled}
        onChange={(value) => setEnabled(value)}
      />
      {enabled && (
        <DsnComponentLayout>
          <Alert severity="info">{t('qapp.design.output_node_info')}</Alert>
          <Stack spacing={2} sx={{ width: '100%' }}>
            {nodeSlots.map((nodeSlot) => (
              <NodeSlotItem
                key={nodeSlot.id}
                nodeSlot={nodeSlot}
                workflow={workflow}
                objectInfos={objectInfos}
                onNodeSlotChange={setNodeSlot}
                onRemove={removeNodeSlot}
              />
            ))}
            <Button variant="text" size="large" color="inherit" onClick={() => addNodeSlot('')}>
              <AddOutlined />
            </Button>
          </Stack>
        </DsnComponentLayout>
      )}
    </>
  )
}

export default DsnOutput
