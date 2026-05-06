import React from 'react'
import {
  Home as HomeIcon,
  Folder as FolderIcon,
  Settings as SettingsIcon,
  Terminal as TerminalIcon,
  ContactSupport as ContactIcon,
  FlashOn as FlashIcon,
  Architecture as ArchitectureIcon,
  Chat as ChatIcon,
  Dvr as ComfyIcon
} from '@mui/icons-material'
import MainPage from './pages/MainPage/MainPage'
import LegacyProjectWebglRedirectPage from './pages/ProjectCanvasPage/LegacyProjectWebglRedirectPage'
import { lazyWithRetry } from './utils/lazyWithRetry'
import {
  LEGACY_PROJECT_WEBGL_ROUTE_PATH,
  PROJECT_CANVAS_ROUTE_PATH
} from './pages/ProjectCanvasPage/projectCanvasRouting'

const ProjectCanvasPage = lazyWithRetry(() => import('./pages/ProjectCanvasPage/ProjectCanvasPage'))
const ModelPage = lazyWithRetry(() => import('./pages/FileBrowserPage/ModelPage'))
const SettingsPage = lazyWithRetry(() => import('./pages/SettingsPage/SettingsPage'))
const TerminalPage = lazyWithRetry(() => import('./pages/TerminalPage'))
const ContactPage = lazyWithRetry(() => import('./pages/ContactPage'))
const QAppExecutePage = lazyWithRetry(() => import('./pages/QuickAppPage/QAppExecutePage'))
const QAppDesignPage = lazyWithRetry(() => import('./pages/QuickAppPage/QAppDesignPage'))
const QAppWorkshopPage = lazyWithRetry(() => import('./pages/QuickAppPage/QAppWorkshopPage'))
const TargetManagerPage = lazyWithRetry(() => import('./pages/QuickAppPage/TargetManagerPage'))
const CustomSkillManagerPage = lazyWithRetry(
  () => import('./pages/QuickAppPage/CustomSkillManagerPage')
)
const ChatPage = lazyWithRetry(() => import('./pages/ChatPage/ChatPage'))
const AppLogPage = lazyWithRetry(() => import('./pages/AppLogPage'))

export type PageType =
  | 'main'
  | 'model'
  | 'settings'
  | 'terminal'
  | 'comfyui'
  | 'contact'
  | 'qappexecute'
  | 'workshop'
  | 'qappdesign'
  | 'target_manager'
  | 'custom_skill_manager'
  | 'project_canvas'
  | 'project_webgl_legacy'
  | 'chat'
  | 'language'

export interface RouteConfig {
  id: PageType
  path: string
  label: string
  labelKey?: string
  Icon: React.ComponentType
  Page: React.ComponentType
  showInSidebar?: boolean
  onlyWhenComfyUIDirAvailable?: boolean
  onlyWhenPythonCmdAvailable?: boolean
  onlyWhenComfyUICommandAvailable?: boolean
  hideWhenRemoteLLM?: boolean
}

export const routes: RouteConfig[] = [
  {
    id: 'main',
    path: '/',
    label: 'Home',
    labelKey: 'menu.home',
    Icon: HomeIcon,
    Page: MainPage,
    showInSidebar: true
  },
  {
    id: 'model',
    path: '/model',
    label: 'Models',
    labelKey: 'menu.models',
    Icon: FolderIcon,
    Page: ModelPage,
    showInSidebar: true,
    onlyWhenComfyUIDirAvailable: true
  },
  {
    id: 'qappexecute',
    path: '/qappexecute',
    label: 'Quick App',
    labelKey: 'menu.quick_app',
    Icon: FlashIcon,
    Page: QAppExecutePage,
    showInSidebar: true
  },
  {
    id: 'workshop',
    path: '/workshop',
    label: 'Workshop',
    labelKey: 'menu.custom_workshop',
    Icon: ArchitectureIcon,
    Page: QAppWorkshopPage,
    showInSidebar: false
  },
  {
    id: 'qappdesign',
    path: '/qappdesign',
    label: 'Custom App',
    labelKey: 'menu.custom_app',
    Icon: ArchitectureIcon,
    Page: QAppDesignPage,
    showInSidebar: false
  },
  {
    id: 'target_manager',
    path: '/target-manager',
    label: 'Target',
    labelKey: 'custom_workshop.target',
    Icon: ArchitectureIcon,
    Page: TargetManagerPage,
    showInSidebar: false
  },
  {
    id: 'custom_skill_manager',
    path: '/custom-skill-manager',
    label: 'Custom Skill',
    labelKey: 'custom_workshop.custom_skill',
    Icon: ArchitectureIcon,
    Page: CustomSkillManagerPage,
    showInSidebar: false
  },
  {
    id: 'project_canvas',
    path: PROJECT_CANVAS_ROUTE_PATH,
    label: 'Project Canvas',
    labelKey: 'menu.canvas',
    Icon: ArchitectureIcon,
    Page: ProjectCanvasPage,
    showInSidebar: false
  },
  {
    id: 'project_webgl_legacy',
    path: LEGACY_PROJECT_WEBGL_ROUTE_PATH,
    label: 'Project WebGL Legacy Redirect',
    Icon: ArchitectureIcon,
    Page: LegacyProjectWebglRedirectPage,
    showInSidebar: false
  },
  {
    id: 'chat',
    path: '/chat',
    label: 'AI Chat',
    labelKey: 'menu.chat',
    Icon: ChatIcon,
    Page: ChatPage,
    showInSidebar: true
  },
  {
    id: 'settings',
    path: '/settings',
    label: 'Settings',
    labelKey: 'menu.settings',
    Icon: SettingsIcon,
    Page: SettingsPage,
    showInSidebar: true
  },
  {
    id: 'terminal',
    path: '/terminal',
    label: 'Terminal',
    labelKey: 'menu.terminal',
    Icon: TerminalIcon,
    Page: AppLogPage,
    showInSidebar: true
  },
  {
    id: 'comfyui',
    path: '/comfyui',
    label: 'ComfyUI',
    labelKey: 'menu.comfyui',
    Icon: ComfyIcon,
    Page: TerminalPage,
    showInSidebar: true,
    onlyWhenComfyUIDirAvailable: true,
    onlyWhenPythonCmdAvailable: true,
    onlyWhenComfyUICommandAvailable: true
  },
  {
    id: 'contact',
    path: '/contact',
    label: 'Contact',
    labelKey: 'menu.contact',
    Icon: ContactIcon,
    Page: ContactPage,
    showInSidebar: true
  }
]

export const getRouteByPath = (path: string): RouteConfig | undefined =>
  routes.find((route) => route.path === path)

export const getRouteById = (id: PageType): RouteConfig | undefined =>
  routes.find((route) => route.id === id)

export const getSidebarRoutes = (): RouteConfig[] => routes.filter((route) => route.showInSidebar)

export const getPathById = (id: PageType): string => getRouteById(id)?.path || '/'

export const getIdByPath = (path: string): PageType => getRouteByPath(path)?.id || 'main'
