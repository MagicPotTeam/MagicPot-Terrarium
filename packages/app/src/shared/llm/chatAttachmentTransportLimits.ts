/** Existing MAIN limit for one LLM chunked-binary attachment, not an aggregate budget. */
export const MAX_LLM_CHUNKED_BINARY_BYTES = 64 * 1024 * 1024

/**
 * Hard per-image cap on the bytes the renderer reads from one un-managed request
 * image (local-media, file path, blob: or an inlined public https image, including
 * image-generation reference images). Counted on bytes actually received, never on
 * Content-Length. Per image only: it does not bound several images together, the
 * producer's prefetch, or the later base64 / IPC copies.
 */
export const MAX_LLM_REQUEST_IMAGE_SOURCE_BYTES = 64 * 1024 * 1024
