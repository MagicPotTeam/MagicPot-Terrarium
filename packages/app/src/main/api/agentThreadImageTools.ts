import Ajv from 'ajv'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import { normalizeMediaReference } from '@shared/mediaReference'
import type { ChatAttachment, ChatMessage, LLMChatResult } from '@shared/llm'
import {
  captureThreadRecentImages,
  prepareThreadInlineImage,
  prepareThreadImageBytes,
  THREAD_IMAGE_INPUT_MAX_BYTES,
  type PreparedThreadImage
} from './agentThreadImageInputs'
import { ASSISTANT_TOOL_OUTCOME_UNKNOWN } from '../assistantRuntime/toolRecovery'
import {
  inspectThreadImageGif,
  THREAD_IMAGE_GIF_LIMITS,
  type ThreadImageGifInfo
} from './agentThreadImageGif'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'

/** MAIN-only backend capability. Never accepted from a renderer or tool arguments. */
export type AgentThreadImageGenerator = {
  /** MAIN-held source-profile opt-in, never tool arguments or linked-target inheritance. */
  gifEnabled?: boolean
  approval: {
    backend: 'codex-json-oauth' | 'codex-json-api-key'
    endpoint: string
    profileId: string
  }
  assertCurrent(): void
  generate(
    prompt: string,
    options: {
      transparentBackground: boolean
      signal: AbortSignal
      gif?: { frameCount?: number; frameDurationMs?: number }
    }
  ): Promise<LLMChatResult>
  edit?(
    prompt: string,
    images: readonly string[],
    options: {
      transparentBackground: boolean
      signal: AbortSignal
      gif?: { frameCount?: number; frameDurationMs?: number }
    }
  ): Promise<LLMChatResult>
}
const stillDefinition = {
  name: 'image_gen',
  description:
    "Generate or edit a raster image using this request's explicitly selected Codex backend. Requires fresh formal approval before uploading input images/generating; returns managed images, never task IDs. num_last_images_to_include edits 1–5 recent images actually supplied to this request, newest-first, or images completed by this tool in this request. Missing, unsupported or unavailable inputs fail, never silently substitute another image. No arbitrary paths/URLs, omitted conversation history, WebP inputs, GIF/animation or non-default EXIF orientation in this slice; recent edits accept static PNG/JPEG only. image.create remains separate ComfyUI workflow submission.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 16000 },
      transparent_background: { type: 'boolean' },
      num_last_images_to_include: { type: 'integer', minimum: 1, maximum: 5 }
    },
    required: ['prompt']
  }
}
const gifSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    frame_count: { type: 'integer', minimum: 2, maximum: 16 },
    frame_duration_ms: { type: 'integer', minimum: 20, maximum: 2000 }
  }
}
const gifDefinition = {
  ...stillDefinition,
  description:
    stillDefinition.description.replace(
      'GIF/animation or non-default EXIF orientation',
      'GIF/animation inputs or non-default EXIF orientation'
    ) +
    ' GIF OUTPUT only is available with the user opt-in: optional gif:{} uses backend defaults; gif.frame_count (2–16), gif.frame_duration_ms (20–2000). GIF edit INPUTS remain unsupported. Returned animation must pass bounded structural/frame/pixel inspection, not a pixel decoder.',
  inputSchema: {
    ...stillDefinition.inputSchema,
    properties: { ...stillDefinition.inputSchema.properties, gif: gifSchema }
  }
}
const ajv = new Ajv({ strict: false, ownProperties: true })
const validateStill = ajv.compile(stillDefinition.inputSchema)
const validateAnimated = ajv.compile(gifDefinition.inputSchema)
const validateGif = ajv.compile(gifSchema)
const MAX_BYTES = 64 * 1024 * 1024
const mimeExtensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

/** Request-owned provider, called through the existing durable tool adapter only.
 * Backend text and returned image content are data, never approval or new authority.
 */
export function createAgentThreadImageTools(options: {
  route: AgentRouteLike
  conversationId: string
  signal: AbortSignal
  generator: AgentThreadImageGenerator
  messages?: readonly ChatMessage[]
  assertInvocation(name: string): void
  assertLive(): void
}): AssistantRunToolProvider & {
  completedAttachments(): ChatAttachment[]
  acceptCompletedResult(result: unknown, signal?: AbortSignal): Promise<void>
} {
  const gifEnabled = options.generator.gifEnabled === true
  const definition = gifEnabled ? gifDefinition : stillDefinition
  const validate = gifEnabled ? validateAnimated : validateStill
  const route = Object.freeze(normalizeAgentRoute(options.route))
  const key = getAgentSessionKey(route)
  const scope = createHash('sha256')
    .update(JSON.stringify([key, options.conversationId]))
    .digest('hex')
  const approval = Object.freeze({ ...options.generator.approval })
  const completed: ChatAttachment[] = []
  const suppliedRecent = captureThreadRecentImages(options.messages ?? [])
  // Only artifacts verified/owned by this MAIN provider enter this list. Renderer
  // attachment.media, receipt URLs and model messages never grant file access.
  const ownedRecent: ChatAttachment[] = []
  const acceptedPublications = new Set<string>()
  let attempts = 0,
    running = false
  return {
    listTools: () => [structuredClone(definition)],
    completedAttachments: () => structuredClone(completed),
    async acceptCompletedResult(value, invocationSignal) {
      // Only the MAIN admission wrapper calls this with the durable runtime's
      // successful result. Model messages/args never reach this publication seam.
      const signal = AbortSignal.any([
        options.signal,
        ...(invocationSignal ? [invocationSignal] : [])
      ])
      const live = () => {
        signal.throwIfAborted()
        options.assertLive()
        options.assertInvocation(definition.name)
        options.generator.assertCurrent()
      }
      live()
      const fail = (): never => {
        throw Object.assign(
          new Error(
            'Saved image result is unavailable or invalid; review it without regenerating.'
          ),
          { code: 'IMAGE_RESULT_RESTORE_FAILED', retryBlocked: true }
        )
      }
      try {
        if (!value || typeof value !== 'object') return fail()
        const result = value as { content?: unknown; metadata?: Record<string, unknown> }
        if (
          typeof result.content !== 'string' ||
          Buffer.byteLength(result.content, 'utf8') > 128 * 1024 ||
          result.metadata?.source !== 'agent-thread-image-gen'
        )
          return fail()
        const publicationId = result.metadata.imagePublicationId
        if (
          publicationId !== undefined &&
          (typeof publicationId !== 'string' || !/^[a-f0-9]{64}$/u.test(publicationId))
        )
          return fail()
        // Chronology key, not a read permit. Fresh results bind their MAIN durable
        // invocation. Legacy receipts lack that key; conservatively dedupe their
        // identical content within this request without inventing a second image.
        const publicationKey =
          typeof publicationId === 'string'
            ? `invocation:${publicationId}`
            : `legacy:${createHash('sha256').update(result.content).digest('hex')}`
        const receipt = JSON.parse(result.content)
        if (
          receipt?.completed !== true ||
          !Number.isInteger(receipt.edited_images) ||
          receipt.edited_images < 0 ||
          receipt.edited_images > 5 ||
          !Array.isArray(receipt.images) ||
          !receipt.images.length ||
          receipt.images.length > 16 ||
          receipt.image_count !== receipt.images.length
        )
          return fail()
        const gifResult = receipt.output_format === 'gif'
        if (
          gifResult &&
          (!gifEnabled ||
            !validateGif(receipt.gif) ||
            !Array.isArray(receipt.gif_outputs) ||
            receipt.gif_outputs.length !== receipt.images.length)
        )
          return fail()
        if (!gifResult && (receipt.gif !== undefined || receipt.gif_outputs !== undefined))
          return fail()
        const references = (receipt.images as unknown[]).map((image, index) => {
          if (
            !image ||
            typeof image !== 'object' ||
            !('type' in image) ||
            image.type !== 'image' ||
            !('media' in image)
          )
            return fail()
          const reference = normalizeMediaReference(image.media)
          const mimeType = reference?.mimeType ?? ''
          if (
            !reference ||
            reference.kind !== 'managed' ||
            !Object.hasOwn(mimeExtensions, mimeType) ||
            (mimeType === 'image/gif') !== gifResult ||
            !reference.sizeBytes ||
            reference.sizeBytes > MAX_BYTES ||
            (reference.status && reference.status !== 'ready') ||
            reference.originalUrl !== undefined ||
            reference.derivatives !== undefined ||
            reference.originalFileName !== `generated-${index + 1}.${mimeExtensions[mimeType]}` ||
            reference.relativePath !==
              `user-output/${scope}/originals/${reference.sha256?.slice(0, 2)}/${reference.sha256}.${mimeExtensions[mimeType]}`
          )
            return fail()
          return reference
        })
        if (references.reduce((sum, reference) => sum + reference.sizeBytes!, 0) > MAX_BYTES)
          return fail()
        const [
          { getChatMediaDir, resolveChatMediaNamespaceDir },
          { resolveManagedMediaReference, readManagedMediaBytes }
        ] = await Promise.all([
          import('../llmProxy/chatMediaDir'),
          import('../llmProxy/managedMediaStore')
        ])
        live()
        const authorizedRoot = getChatMediaDir()
        const root = resolveChatMediaNamespaceDir('user-output', scope)
        const attachments: ChatAttachment[] = []
        let restoredGifPixels = 0
        for (const [index, reference] of references.entries()) {
          live()
          const resolved = await resolveManagedMediaReference(root, reference, { authorizedRoot })
          live()
          if (gifResult) {
            // Consume the verified handle-read bytes; never reopen its pathname as authority.
            const bytes = await readManagedMediaBytes(resolved.storeRoot!, resolved.metadata, {
              authorizedRoot,
              maxBytes: MAX_BYTES
            })
            live()
            const info = inspectThreadImageGif(bytes)
            restoredGifPixels += info.totalFramePixels
            const recorded = receipt.gif_outputs[index]
            if (
              restoredGifPixels > THREAD_IMAGE_GIF_LIMITS.maxTotalFramePixels ||
              !recorded ||
              Object.keys(info).some(
                (key) => recorded[key] !== info[key as keyof ThreadImageGifInfo]
              ) ||
              (receipt.gif.frame_count !== undefined && info.frameCount !== receipt.gif.frame_count)
            )
              return fail()
          }
          attachments.push({
            type: 'image',
            url: resolved.localMediaUrl,
            media: resolved.reference,
            mimeType: resolved.reference.mimeType,
            sizeBytes: resolved.reference.sizeBytes,
            fileName: resolved.reference.originalFileName
          })
        }
        live()
        // Publish only the whole verified batch, never a partial replay. Ignore
        // receipt URLs; resolution recomputes the app-owned local-media URL.
        if (!acceptedPublications.has(publicationKey)) {
          completed.push(
            ...attachments.filter((image) => !completed.some((old) => old.url === image.url))
          )
          ownedRecent.push(...attachments)
          ownedRecent.splice(0, Math.max(0, ownedRecent.length - 5))
          acceptedPublications.add(publicationKey)
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason
        // No generator/re-approval/import/fallback runs on restoration failure.
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'IMAGE_RESULT_RESTORE_FAILED'
        )
          throw error
        return fail()
      }
    },
    async callTool(name, args, context) {
      const signal = AbortSignal.any([options.signal, ...(context.signal ? [context.signal] : [])])
      const live = () => {
        signal.throwIfAborted()
        options.assertLive()
        options.assertInvocation(name)
        options.generator.assertCurrent()
      }
      live()
      if (name !== definition.name || getAgentSessionKey(context.route) !== key)
        throw new Error('Image tool is outside this Agent thread.')
      const input = structuredClone(args)
      if (!validate(input) || typeof input.prompt !== 'string' || !input.prompt.trim())
        throw new Error(
          'Invalid image_gen arguments; use bounded prompt, transparent_background, num_last_images_to_include (1–5), and gif controls only when explicitly enabled.'
        )
      if (running || ++attempts > 2)
        throw new Error(
          'Image generation request budget exhausted or an invocation is still running.'
        )
      running = true
      let dispatched = false
      try {
        const count = input.num_last_images_to_include as number | undefined
        const inputs: PreparedThreadImage[] = []
        if (count !== undefined) {
          if (!options.generator.edit) throw new Error('Selected image backend cannot edit images.')
          const recent = [...ownedRecent].reverse()
          if (recent.length + suppliedRecent.length < count)
            throw new Error(
              `Only ${recent.length + suppliedRecent.length} recent image(s) are available in this request; ${count} requested. Attach the missing images.`
            )
          for (let index = 0; index < count; index++) {
            live()
            if (index >= recent.length) {
              inputs.push(
                await prepareThreadInlineImage(suppliedRecent[index - recent.length], live)
              )
            } else {
              const reference = recent[index].media!
              if (!reference.sizeBytes || reference.sizeBytes > THREAD_IMAGE_INPUT_MAX_BYTES)
                throw new Error('Recent image exceeds the input byte limit.')
              const [
                { getChatMediaDir, resolveChatMediaNamespaceDir },
                { resolveManagedMediaReference, readManagedMediaBytes }
              ] = await Promise.all([
                import('../llmProxy/chatMediaDir'),
                import('../llmProxy/managedMediaStore')
              ])
              live()
              const authorizedRoot = getChatMediaDir()
              const resolved = await resolveManagedMediaReference(
                resolveChatMediaNamespaceDir('user-output', scope),
                reference,
                { authorizedRoot }
              )
              live()
              const bytes = await readManagedMediaBytes(resolved.storeRoot!, resolved.metadata, {
                authorizedRoot,
                maxBytes: THREAD_IMAGE_INPUT_MAX_BYTES
              })
              live()
              inputs.push(await prepareThreadImageBytes(bytes, reference.mimeType, live))
            }
          }
        }
        live()
        // Exact prompt + input hashes/bytes + destination/backend, no encoded data
        // or key/token. Capture bytes before approval; feedback is not a permit.
        const { requestCreativeToolApproval } =
          await import('../magicAgentRuntime/creativeToolApproval')
        live()
        await requestCreativeToolApproval({
          toolName: name,
          route,
          signal,
          args: {
            ...input,
            ...approval,
            conversationId: options.conversationId,
            model: 'gpt-image-2',
            mayIncurCost: true,
            persistsManagedImages: true,
            ...(input.gif !== undefined
              ? { output_format: 'gif', gifOutputLimits: THREAD_IMAGE_GIF_LIMITS }
              : {}),
            ...(inputs.length
              ? { inputImages: inputs.map((image) => image.receipt), uploadsInputImages: true }
              : {})
          }
        })
        live()
        dispatched = true
        const gif = input.gif as { frame_count?: number; frame_duration_ms?: number } | undefined
        const params = {
          transparentBackground: input.transparent_background === true,
          signal,
          ...(gif !== undefined
            ? {
                gif: {
                  ...(gif.frame_count !== undefined ? { frameCount: gif.frame_count } : {}),
                  ...(gif.frame_duration_ms !== undefined
                    ? { frameDurationMs: gif.frame_duration_ms }
                    : {})
                }
              }
            : {})
        }
        const result = inputs.length
          ? await options.generator.edit!(
              input.prompt,
              inputs.map((image) => image.dataUrl),
              params
            )
          : await options.generator.generate(input.prompt, params)
        live()
        const images = result.attachments
        if (
          !images?.length ||
          images.length > 16 ||
          (result.finishReason !== undefined && result.finishReason !== 'stop')
        )
          throw new Error('No completed images were returned.')
        const parsed = images.map((image) => {
          if (image.type !== 'image' || typeof image.url !== 'string')
            throw new Error('Invalid image output.')
          const prefix = /^data:(image\/(?:png|jpeg|webp|gif));base64,/u.exec(image.url)
          if (
            !prefix ||
            !Object.hasOwn(mimeExtensions, prefix[1]) ||
            (prefix[1] === 'image/gif') !== (gif !== undefined) ||
            (image.mimeType !== undefined && image.mimeType !== prefix[1])
          )
            throw new Error('Image output must be an inline supported raster.')
          const encodedLength = image.url.length - prefix[0].length
          if (
            !encodedLength ||
            encodedLength > Math.ceil(MAX_BYTES / 3) * 4 ||
            encodedLength % 4 !== 0
          )
            throw new Error('Image output exceeds the byte limit or is malformed.')
          return { image, mimeType: prefix[1], start: prefix[0].length, encodedLength }
        })
        if (parsed.reduce((sum, image) => sum + (image.encodedLength * 3) / 4, 0) > MAX_BYTES)
          throw new Error('Combined image output exceeds the byte limit.')
        const gifOutputs: ThreadImageGifInfo[] = []
        let totalGifPixels = 0
        // Validate ALL decoded payloads before any managed import or publication.
        const decoded = parsed.map((image) => {
          const encoded = image.image.url.slice(image.start)
          const bytes = Buffer.from(encoded, 'base64')
          if (!bytes.length || bytes.toString('base64') !== encoded)
            throw new Error('Invalid base64 image output.')
          if (gif !== undefined) {
            const info = inspectThreadImageGif(bytes)
            totalGifPixels += info.totalFramePixels
            if (
              totalGifPixels > THREAD_IMAGE_GIF_LIMITS.maxTotalFramePixels ||
              (gif.frame_count !== undefined && info.frameCount !== gif.frame_count)
            )
              throw new Error(
                'GIF output does not match requested frames or exceeds the batch pixel budget.'
              )
            gifOutputs.push(info)
          }
          return { ...image, bytes }
        })
        const [{ getChatMediaDir, getChatMediaNamespaceDir }, { importManagedMediaStream }] =
          await Promise.all([
            import('../llmProxy/chatMediaDir'),
            import('../llmProxy/managedMediaStore')
          ])
        live()
        const attachments: ChatAttachment[] = []
        const authorizedRoot = getChatMediaDir()
        const chatMediaRoot = getChatMediaNamespaceDir('user-output', scope)
        for (const [index, image] of decoded.entries()) {
          live()
          const bytes = image.bytes
          const fileName = `generated-${index + 1}.${mimeExtensions[image.mimeType]}`
          const imported = await importManagedMediaStream(
            {
              chatMediaRoot,
              stream: Readable.from([bytes]),
              mimeType: image.mimeType,
              originalFileName: fileName,
              provenance: {
                source: 'agent-thread-image-gen',
                conversationId: options.conversationId,
                runId: context.runId,
                toolCallId: context.toolCallId
              },
              maxBytes: MAX_BYTES,
              signal
            },
            { authorizedRoot }
          )
          live()
          attachments.push({
            type: 'image',
            url: imported.localMediaUrl,
            media: imported.reference,
            mimeType: imported.reference.mimeType,
            sizeBytes: imported.reference.sizeBytes,
            fileName
          })
        }
        live()
        // Return only after ALL imports succeed. The admission wrapper publishes
        // after durable success, including receipt replay, with current integrity
        // and ownership checks. A failed import may still leave saved files;
        // neither local nor remote side effects are claimed rolled back.
        return {
          content: JSON.stringify({
            completed: true,
            image_count: attachments.length,
            edited_images: inputs.length,
            ...(gif !== undefined ? { output_format: 'gif', gif, gif_outputs: gifOutputs } : {}),
            images: attachments
          }),
          metadata: {
            source: 'agent-thread-image-gen',
            imagePublicationId: createHash('sha256')
              .update(JSON.stringify([context.runId, context.toolCallId ?? null]))
              .digest('hex'),
            image_count: attachments.length,
            edited_images: inputs.length
          }
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (!dispatched) throw error
        // A failed/missing output or import does not prove the request was uncharged.
        // Existing journal replay recognizes this code and refuses redispatch.
        throw Object.assign(
          new Error(
            'Image generation or persistence failed after dispatch. The outcome may be unknown; review before retrying.'
          ),
          { code: ASSISTANT_TOOL_OUTCOME_UNKNOWN, retryBlocked: true }
        )
      } finally {
        running = false
      }
    }
  }
}
