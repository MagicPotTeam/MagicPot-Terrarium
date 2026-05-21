import type { ProjectTraceProjectRef } from '@shared/projectTrace'
import { normalizeGeneratedRootDirName } from '@shared/projectStorage'
import { buildProjectStorageDirName, getProjectById } from '../../pages/MainPage/projectStore'
import { getProjectCanvasLocation } from '../../pages/ProjectCanvasPage/canvasStorage'

export async function resolveCanvasProjectTraceProjectRef(
  canvasId: string,
  projectName?: string
): Promise<ProjectTraceProjectRef> {
  const project = getProjectById(canvasId)
  const projectStorageDirName =
    (project?.storageDirName ? normalizeGeneratedRootDirName(project.storageDirName) : '') ||
    buildProjectStorageDirName(projectName || canvasId, canvasId)
  const location = await getProjectCanvasLocation(canvasId).catch(() => null)

  return {
    projectId: canvasId,
    projectName: projectName || project?.name,
    projectStorageDirName,
    ...(location?.projectRootDir ? { projectRootDir: location.projectRootDir } : {})
  }
}
