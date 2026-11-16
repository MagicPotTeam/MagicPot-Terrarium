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

/**
 * MAIN's limits on the ORIGINAL inline image bytes of one built-in OpenAI Responses
 * request before it re-encodes them (responsesImageProjectionCandidate.ts): one image,
 * and all inline images of the request together. GIFs count; public HTTP(S) URLs do not.
 * The renderer refuses a request from descriptors when these are certainly exceeded.
 */
export const MAX_CHAT_IMAGE_PREPARATION_SOURCE_BYTES = 20 * 1024 * 1024
export const MAX_CHAT_IMAGE_PREPARATION_BATCH_SOURCE_BYTES = 32 * 1024 * 1024

/** MAIN's limit on the JSON body it forwards to a remote LLM server for one streamed request. */
export const MAX_REMOTE_CHAT_STREAM_REQUEST_BYTES = 16 * 1024 * 1024
