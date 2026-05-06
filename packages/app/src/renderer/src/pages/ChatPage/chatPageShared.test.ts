import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildHy3dProfileId,
  clearScopedExternalLoadingSessionIds,
  getBaseProfileId,
  getDownloadFileNameFromUrl,
  isModel3DUrl,
  normalizeChatProfileIdForStorage,
  readScopedExternalLoadingSessionIds,
  readScopedLoadingSessionIds,
  scopedStorageKey,
  STORAGE_KEY_EXTERNAL_LOADING_IDS,
  STORAGE_KEY_LOADING_IDS,
  updateScopedExternalLoadingSessionId
} from './chatPageShared'
import { DEFAULT_PARAMS } from './hy3d/types'

beforeEach(() => {
  localStorage.clear()
  clearScopedExternalLoadingSessionIds()
})

describe('buildHy3dProfileId', () => {
  it('encodes the selected Hunyuan3D params into a composite profile id', () => {
    expect(
      buildHy3dProfileId({
        ...DEFAULT_PARAMS,
        apiAction: 'SubmitHunyuanTo3DRapidJob',
        modelVersion: '3.0',
        generateType: 'Geometry',
        faceCount: 3000,
        targetFormat: 'GLB',
        polygonType: 'quadrilateral',
        enablePBR: true
      })
    ).toBe(
      'hunyuan3d-pro::SubmitHunyuanTo3DRapidJob::3.0::Geometry::3000::GLB::quadrilateral::quadrilateral::1::DEFAULT'
    )
  })

  it('uses the texture PBR toggle and convert target format for special actions', () => {
    expect(
      buildHy3dProfileId({
        ...DEFAULT_PARAMS,
        apiAction: 'Convert3DFormat',
        convertTargetFormat: 'MP4',
        enablePBR: false,
        textureEnablePBR: true
      })
    ).toBe(
      'hunyuan3d-pro::Convert3DFormat::3.1::Normal::500000::MP4::triangle::triangle::0::DEFAULT'
    )
  })

  it('appends an encoded source file name hint when a post-process model came from an extensionless link', () => {
    expect(
      buildHy3dProfileId({
        ...DEFAULT_PARAMS,
        apiAction: 'SubmitTextureTo3DJob',
        modelSourceFileName: 'Generated OBJ Package.zip'
      })
    ).toBe(
      'hunyuan3d-pro::SubmitTextureTo3DJob::3.1::Normal::500000::DEFAULT::triangle::triangle::0::DEFAULT::Generated%20OBJ%20Package.zip'
    )
  })

  it('can still recover the base profile id from a composite Hunyuan id', () => {
    expect(getBaseProfileId(buildHy3dProfileId(DEFAULT_PARAMS))).toBe('hunyuan3d-pro')
  })

  it('normalizes stored composite profile ids to their base profile', () => {
    expect(normalizeChatProfileIdForStorage(buildHy3dProfileId(DEFAULT_PARAMS))).toBe(
      'hunyuan3d-pro'
    )
  })
})

describe('download file name hints', () => {
  it('reads a useful file name from extensionless signed urls when the query carries one', () => {
    expect(
      getDownloadFileNameFromUrl(
        'https://example.com/download?id=model-1&filename=chair.glb',
        'fallback.glb'
      )
    ).toBe('chair.glb')
  })

  it('treats extensionless signed urls with a filename query hint as model links', () => {
    expect(
      isModel3DUrl('https://example.com/download?id=model-2&filename=generated-mesh.fbx')
    ).toBe(true)
  })
})

describe('external loading session ids', () => {
  it('merges regular and external loading session ids for the same scope', () => {
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_LOADING_IDS, 'project.agent-1'),
      JSON.stringify(['session-a'])
    )
    updateScopedExternalLoadingSessionId('project.agent-1', 'session-b', true)
    updateScopedExternalLoadingSessionId('project.agent-1', 'session-a', true)

    expect(readScopedLoadingSessionIds('project.agent-1')).toEqual(['session-a', 'session-b'])
  })

  it('adds and removes external loading session ids without touching other scopes', () => {
    expect(updateScopedExternalLoadingSessionId('project.agent-1', 'session-a', true)).toEqual([
      'session-a'
    ])
    expect(readScopedExternalLoadingSessionIds('project.agent-1')).toEqual(['session-a'])

    updateScopedExternalLoadingSessionId('project.agent-2', 'session-b', true)
    expect(readScopedExternalLoadingSessionIds('project.agent-2')).toEqual(['session-b'])

    expect(updateScopedExternalLoadingSessionId('project.agent-1', 'session-a', false)).toEqual([])
    expect(readScopedExternalLoadingSessionIds('project.agent-1')).toEqual([])
    expect(readScopedExternalLoadingSessionIds('project.agent-2')).toEqual(['session-b'])
  })

  it('drops legacy persisted external loading ids when reading a scope', () => {
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_EXTERNAL_LOADING_IDS, 'project.agent-legacy'),
      JSON.stringify(['stale-session'])
    )

    expect(readScopedExternalLoadingSessionIds('project.agent-legacy')).toEqual([])
    expect(
      localStorage.getItem(
        scopedStorageKey(STORAGE_KEY_EXTERNAL_LOADING_IDS, 'project.agent-legacy')
      )
    ).toBeNull()
  })
})
