import { ExtensionType, extensions, glUploadImageResource } from 'pixi.js'

// Chromium stages a WebGL upload in the context's transfer buffer (16 MiB at most). A texImage2D
// that does not fit there is staged in a shared-memory chunk of its own size, which the context
// keeps for its whole life (one 2048 px source upload left a 32 MB chunk behind). A source above
// this many bytes is therefore uploaded as horizontal strips of at most this many bytes each
// (texSubImage2D of a row range), which always fit in the transfer buffer. All strips of a
// texture go up in the same call, before the texture is drawn: it is never seen half uploaded,
// and a texture that waits for its frame waits whole.
export const PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_STRIP_BYTES = 4 * 1024 * 1024
export const PROJECT_CANVAS_WEBGL_STRIP_UPLOAD_METHOD_ID = 'project-canvas-strips'

type ProjectCanvasStripUploadSource = {
  pixelWidth: number
  pixelHeight: number
  resourceWidth: number
  resourceHeight: number
  resource: unknown
}

type ProjectCanvasStripUploadGlTexture = {
  target: number
  internalFormat: number
  format: number
  type: number
  width: number
  height: number
}

type ProjectCanvasStripUploadGl = {
  UNPACK_SKIP_ROWS?: number
  pixelStorei: (pname: number, param: number) => void
  texImage2D: (...args: unknown[]) => void
  texSubImage2D: (...args: unknown[]) => void
}

// WebGL 2 constant (also on WebGL2RenderingContext; spelled out for contexts that lack it).
const PROJECT_CANVAS_WEBGL_UNPACK_SKIP_ROWS = 0x0cf3

/**
 * Pixi upload method for large decoded sources: allocates the texture, then uploads the image
 * as row strips of at most PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_STRIP_BYTES (WebGL 2 selects the
 * rows of a TexImageSource with UNPACK_SKIP_ROWS). Anything else (WebGL 1, a small image) goes
 * through Pixi's own image upload unchanged.
 */
export function uploadProjectCanvasTextureInStrips(
  source: ProjectCanvasStripUploadSource,
  glTexture: ProjectCanvasStripUploadGlTexture,
  gl: ProjectCanvasStripUploadGl,
  webGLVersion: number,
  ...rest: unknown[]
): void {
  const textureWidth = source.pixelWidth
  const textureHeight = source.pixelHeight
  const uploadWidth = Math.min(textureWidth, source.resourceWidth)
  const uploadHeight = Math.min(textureHeight, source.resourceHeight)
  const rowBytes = uploadWidth * 4
  if (
    webGLVersion !== 2 ||
    // A target override or forced allocation (cube faces) is Pixi's own business.
    rest.some((argument) => argument !== undefined) ||
    !(uploadWidth > 0) ||
    !(uploadHeight > 0) ||
    rowBytes * uploadHeight <= PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_STRIP_BYTES ||
    typeof gl.texSubImage2D !== 'function'
  ) {
    ;(glUploadImageResource.upload as (...args: unknown[]) => void)(
      source,
      glTexture,
      gl,
      webGLVersion,
      ...rest
    )
    return
  }

  const target = glTexture.target
  if (glTexture.width !== textureWidth || glTexture.height !== textureHeight) {
    gl.texImage2D(
      target,
      0,
      glTexture.internalFormat,
      textureWidth,
      textureHeight,
      0,
      glTexture.format,
      glTexture.type,
      null
    )
  }
  const skipRows = gl.UNPACK_SKIP_ROWS ?? PROJECT_CANVAS_WEBGL_UNPACK_SKIP_ROWS
  const rowsPerStrip = Math.max(
    1,
    Math.floor(PROJECT_CANVAS_WEBGL_TEXTURE_UPLOAD_STRIP_BYTES / rowBytes)
  )
  try {
    for (let row = 0; row < uploadHeight; row += rowsPerStrip) {
      const rows = Math.min(rowsPerStrip, uploadHeight - row)
      gl.pixelStorei(skipRows, row)
      gl.texSubImage2D(
        target,
        0,
        0,
        row,
        uploadWidth,
        rows,
        glTexture.format,
        glTexture.type,
        source.resource
      )
    }
  } finally {
    gl.pixelStorei(skipRows, 0)
  }
  glTexture.width = textureWidth
  glTexture.height = textureHeight
}

type ProjectCanvasStripTextureUploader = {
  extension: { type: ExtensionType; name: string }
  id: string
  upload: typeof uploadProjectCanvasTextureInStrips
}

let projectCanvasStripTextureUploader: ProjectCanvasStripTextureUploader | null = null

/** The registered strip upload method, or null when it could not be registered. */
export function getRegisteredProjectCanvasStripTextureUploader() {
  return projectCanvasStripTextureUploader
}

/**
 * Registers the strip upload method with Pixi. Pixi copies the registered upload methods into
 * each renderer when it is created, so this runs before the layer creates its application.
 */
export function registerProjectCanvasStripTextureUploader() {
  if (projectCanvasStripTextureUploader) {
    return
  }
  const uploader = {
    extension: {
      type: ExtensionType.TextureUploaderWebGL,
      name: PROJECT_CANVAS_WEBGL_STRIP_UPLOAD_METHOD_ID
    },
    id: PROJECT_CANVAS_WEBGL_STRIP_UPLOAD_METHOD_ID,
    upload: uploadProjectCanvasTextureInStrips
  }
  try {
    extensions.add(uploader)
    projectCanvasStripTextureUploader = uploader
  } catch (error) {
    console.warn('[Canvas WebGL] Strip texture upload is unavailable:', error)
  }
}
