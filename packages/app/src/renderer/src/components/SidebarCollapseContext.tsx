// packages/app/src/renderer/src/components/sidebar-state/SidebarCollapseContext.ts
import React, { createContext, useContext } from 'react'

export type SidebarCollapseCtx = {
  collapsed: boolean
  toggle: () => void
}

export const SidebarCollapseContext = createContext<SidebarCollapseCtx | null>(null)

export function useSidebarCollapse() {
  const ctx = useContext(SidebarCollapseContext)
  if (!ctx) throw new Error('useSidebarCollapse must be used within SidebarCollapseProvider')
  return ctx
}
