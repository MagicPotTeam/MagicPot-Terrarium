import { describe, expect, it } from 'vitest'
import { apiDef } from './index'

describe('apiDef', () => {
  it('exposes the project canvas thumbnail service contract', () => {
    expect(apiDef.svcCanvasThumbnail).toBeDefined()
    expect(apiDef.svcCanvasThumbnail.getSourceFileMetadata.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.getThumbnailCacheRoot.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.readThumbnailManifest.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.writeThumbnailSet.type).toBe('unary')
    expect(apiDef.svcCanvasThumbnail.createNativeThumbnail.type).toBe('unary')
  })

  it('exposes the app update service contract', () => {
    expect(apiDef.svcAppUpdate).toBeDefined()
    expect(apiDef.svcAppUpdate.getStatus.type).toBe('unary')
    expect(apiDef.svcAppUpdate.checkForUpdates.type).toBe('unary')
    expect(apiDef.svcAppUpdate.downloadUpdate.type).toBe('unary')
    expect(apiDef.svcAppUpdate.installUpdate.type).toBe('unary')
    expect(apiDef.svcAppUpdate.watchStatus.type).toBe('serverStreaming')
  })
})
