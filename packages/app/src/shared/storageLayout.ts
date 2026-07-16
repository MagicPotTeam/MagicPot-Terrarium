import type { BuiltInPath } from './utils/utilWindow'

export const STORAGE_DATA_DIRNAME = 'Data'
export const STORAGE_PROJECTS_DIRNAME = 'Projects'
export const STORAGE_AUTOSAVE_DIRNAME = 'AutoSave'

export type StorageLayout = {
  root: string
  data: string
  projects: string
  autoSave: string
}

type PathLike = Pick<BuiltInPath, 'join'>

export function resolveStorageLayout(root: string, pathApi: PathLike): StorageLayout {
  const normalizedRoot = String(root || '').trim()
  return {
    root: normalizedRoot,
    data: pathApi.join(normalizedRoot, STORAGE_DATA_DIRNAME),
    projects: pathApi.join(normalizedRoot, STORAGE_PROJECTS_DIRNAME),
    autoSave: pathApi.join(normalizedRoot, STORAGE_AUTOSAVE_DIRNAME)
  }
}
