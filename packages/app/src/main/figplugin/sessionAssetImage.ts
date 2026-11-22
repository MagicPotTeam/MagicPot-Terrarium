import {
  FIGPLUGIN_ASSET_MAX_BYTES,
  FIGPLUGIN_ASSET_MAX_EDGE,
  FIGPLUGIN_ASSET_MAX_PIXELS,
  type FigPluginAssetMime
} from '@shared/figplugin/hostAssets'
import { inspectStillRaster } from '../utils/stillRaster'

/** Structural/dimension preflight, not a claim that compressed pixels decoded.
 * Desktop must also decode these same bytes before granting a session lease.
 * Preserve the existing session-specific limits, error and three-field result.
 */
export function inspectSessionAssetImage(bytes: Uint8Array): {
  mimeType: FigPluginAssetMime
  width: number
  height: number
} {
  try {
    const { mimeType, width, height } = inspectStillRaster(bytes, {
      maxBytes: FIGPLUGIN_ASSET_MAX_BYTES,
      maxEdge: FIGPLUGIN_ASSET_MAX_EDGE,
      maxPixels: FIGPLUGIN_ASSET_MAX_PIXELS
    })
    return { mimeType, width, height }
  } catch {
    throw new Error('INVALID_SESSION_IMAGE')
  }
}
