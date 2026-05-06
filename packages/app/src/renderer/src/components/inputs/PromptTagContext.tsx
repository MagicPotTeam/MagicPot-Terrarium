/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useCallback, useMemo, useRef } from 'react'
import { DragDropContext, DropResult } from '@hello-pangea/dnd'

interface PromptTag {
  id: string
  text: string
  weight: number
  disabled?: boolean
}

interface PromptTagContextValue {
  registerDroppable: (
    id: string,
    onMove: (tag: PromptTag, destinationIndex: number) => void,
    onRemove: (tagId: string) => void,
    onReorder: (sourceIndex: number, destIndex: number) => void
  ) => void
  unregisterDroppable: (id: string) => void
}

const PromptTagContext = createContext<PromptTagContextValue | null>(null)

export const usePromptTagContext = () => {
  const context = useContext(PromptTagContext)
  return context
}

interface PromptTagProviderProps {
  children: React.ReactNode
}

export const PromptTagProvider: React.FC<PromptTagProviderProps> = ({ children }) => {
  const droppablesRef = useRef(
    new Map<
      string,
      {
        onMove: (tag: PromptTag, destinationIndex: number) => void
        onRemove: (tagId: string) => void
        onReorder: (sourceIndex: number, destIndex: number) => void
      }
    >()
  )

  const registerDroppable = useCallback(
    (
      id: string,
      onMove: (tag: PromptTag, destinationIndex: number) => void,
      onRemove: (tagId: string) => void,
      onReorder: (sourceIndex: number, destIndex: number) => void
    ) => {
      droppablesRef.current.set(id, { onMove, onRemove, onReorder })
    },
    []
  )

  const unregisterDroppable = useCallback((id: string) => {
    droppablesRef.current.delete(id)
  }, [])

  const handleDragEnd = useCallback((result: DropResult) => {
    const { source, destination, draggableId } = result

    if (!destination) return

    const sourceDroppable = droppablesRef.current.get(source.droppableId)
    const destDroppable = droppablesRef.current.get(destination.droppableId)

    if (!sourceDroppable || !destDroppable) return

    // 如果是内部排序（同一个容器）
    if (source.droppableId === destination.droppableId) {
      sourceDroppable.onReorder(source.index, destination.index)
      return
    }

    // 解析标签信息从 draggableId
    // 格式: tagId|||text|||weight
    const parts = draggableId.split('|||')
    if (parts.length !== 3) return

    const tag: PromptTag = {
      id: parts[0],
      text: parts[1],
      weight: parseFloat(parts[2])
    }

    // 跨容器拖拽
    // 从源容器移除
    sourceDroppable.onRemove(tag.id)
    // 添加到目标容器
    destDroppable.onMove(tag, destination.index)
  }, [])

  const contextValue = useMemo(
    () => ({
      registerDroppable,
      unregisterDroppable
    }),
    [registerDroppable, unregisterDroppable]
  )

  return (
    <PromptTagContext.Provider value={contextValue}>
      <DragDropContext onDragEnd={handleDragEnd}>{children}</DragDropContext>
    </PromptTagContext.Provider>
  )
}
