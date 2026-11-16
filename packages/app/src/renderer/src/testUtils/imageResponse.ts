/**
 * A fetched image as the renderer receives it from native fetch: a real
 * Response whose bytes arrive through its body stream. Request images are read
 * only through that stream under the per-image byte cap, and a response without
 * a readable body is refused, so image fixtures must not fake a response that
 * offers only blob() or arrayBuffer().
 */
export function createImageResponse(
  content: string | Uint8Array | ReadableStream<Uint8Array>,
  options: { type?: string; status?: number } = {}
): Response {
  const body =
    typeof content === 'string'
      ? new TextEncoder().encode(content)
      : content instanceof Uint8Array
        ? new Uint8Array(content)
        : content
  return new Response(body, {
    status: options.status ?? 200,
    headers: { 'content-type': options.type ?? 'image/png' }
  })
}
