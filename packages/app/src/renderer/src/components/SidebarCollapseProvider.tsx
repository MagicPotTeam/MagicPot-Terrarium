// packages/app/src/renderer/src/components/sidebar-state/SidebarCollapseProvider.tsx
import React, { useMemo, useState } from 'react'
import { SidebarCollapseContext, SidebarCollapseCtx } from './SidebarCollapseContext'

const STORAGE_KEY = 'sidebar.collapsed' // 可选：保留折叠状态（若不需要可删）

const SidebarCollapseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved ? JSON.parse(saved) : false
    } catch {
      return false
    }
  })

  const value = useMemo<SidebarCollapseCtx>(
    () => ({
      collapsed,
      toggle: () => {
        setCollapsed((v) => {
          const next = !v
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
          } catch {
            // ignore errors
          }
          return next
        })
      }
    }),
    [collapsed]
  )

  return <SidebarCollapseContext.Provider value={value}>{children}</SidebarCollapseContext.Provider>
}

export default SidebarCollapseProvider
