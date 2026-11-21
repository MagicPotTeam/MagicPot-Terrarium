import { REPORT_BUNDLES_ROOT_DIR_NAME } from '@shared/reportBundle'

/** Managed media: chat attachments, ComfyUI and provider outputs, their derivatives. */
export const CHAT_MEDIA_DIRNAME = '.chat_media'
/** Canvas thumbnails (svcCanvasThumbnail's default cache root). */
export const CANVAS_THUMBNAIL_CACHE_DIRNAME = 'project-canvas-thumbnail-cache'
/** QuickApp input images (svcFs.saveQAppInputImage). */
export const QAPP_INPUT_IMAGE_DIRNAME = 'qapp-input-images'
/** The report-bundle registry's snapshots (their manifests are local-media URLs). */
export const REPORT_BUNDLE_SNAPSHOT_DIRNAME = 'report-bundles'

/**
 * The folders of the app's data folder whose files the renderer displays through the
 * local-media protocol, and the only ones there that it may read as media. The rest of the data
 * folder (config.json with every API key, the grants file, chats, custom skills, Chromium's
 * profile) is never served: a board item, a skill or a chat attachment can name any path.
 * `.report_bundles` holds the report bundles written under the data folder (a canvas target
 * report when no download folder is configured).
 */
export const USER_DATA_MEDIA_DIRNAMES: readonly string[] = [
  CHAT_MEDIA_DIRNAME,
  CANVAS_THUMBNAIL_CACHE_DIRNAME,
  QAPP_INPUT_IMAGE_DIRNAME,
  REPORT_BUNDLES_ROOT_DIR_NAME,
  REPORT_BUNDLE_SNAPSHOT_DIRNAME
]
