import { createDragDropManager, type DragDropManager } from 'dnd-core'
import { HTML5Backend } from 'react-dnd-html5-backend'

const DND_MANAGER_KEY = '__magicpotDndManager__'

type GlobalWithDndManager = typeof globalThis & {
  [DND_MANAGER_KEY]?: DragDropManager
}

export function getAppDndManager(): DragDropManager {
  const globalObject = globalThis as GlobalWithDndManager

  if (!globalObject[DND_MANAGER_KEY]) {
    const context = typeof window !== 'undefined' ? window : globalThis
    globalObject[DND_MANAGER_KEY] = createDragDropManager(HTML5Backend, context)
  }

  return globalObject[DND_MANAGER_KEY]
}
