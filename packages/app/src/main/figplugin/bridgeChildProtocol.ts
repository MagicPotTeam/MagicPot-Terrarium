import { figPluginBridgeOriginSchema } from '@shared/figplugin/bridge'
import { z } from 'zod'

/**
 * The utility process receives one JSON string per Electron IPC message.  The
 * marker is part of the wire format rather than a TypeScript-only tag: a
 * child must reject an object from any other IPC channel before inspecting
 * protocol fields.
 */
export const FIGPLUGIN_BRIDGE_CHILD_FRAME = 'magicpot.figplugin.bridge-child/v1' as const
export const FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL = 1 as const
export const FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES = 4096

const nonceSchema = z.string().regex(/^[a-f0-9]{32}$/)
const bootstrapSchema = z
  .object({
    frame: z.literal(FIGPLUGIN_BRIDGE_CHILD_FRAME),
    kind: z.literal('bootstrap'),
    protocol: z.literal(FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL),
    nonce: nonceSchema,
    origin: figPluginBridgeOriginSchema
  })
  .strict()
const readySchema = z
  .object({
    frame: z.literal(FIGPLUGIN_BRIDGE_CHILD_FRAME),
    kind: z.literal('ready'),
    protocol: z.literal(FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL),
    nonce: nonceSchema,
    origin: figPluginBridgeOriginSchema
  })
  .strict()
const shutdownSchema = z
  .object({
    frame: z.literal(FIGPLUGIN_BRIDGE_CHILD_FRAME),
    kind: z.literal('shutdown'),
    protocol: z.literal(FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL),
    nonce: nonceSchema,
    origin: figPluginBridgeOriginSchema,
    reason: z.literal('supervisor-stop')
  })
  .strict()

export const figPluginBridgeChildFrameSchema = z.discriminatedUnion('kind', [
  bootstrapSchema,
  readySchema,
  shutdownSchema
])

export type FigPluginBridgeBootstrapFrame = z.output<typeof bootstrapSchema>
export type FigPluginBridgeReadyFrame = z.output<typeof readySchema>
export type FigPluginBridgeShutdownFrame = z.output<typeof shutdownSchema>
export type FigPluginBridgeChildFrame = z.output<typeof figPluginBridgeChildFrameSchema>
export type FigPluginBridgeProcessMessage =
  | Omit<FigPluginBridgeBootstrapFrame, 'frame'>
  | Omit<FigPluginBridgeReadyFrame, 'frame'>
  | Omit<FigPluginBridgeShutdownFrame, 'frame'>

const withFrame = (message: FigPluginBridgeProcessMessage): FigPluginBridgeChildFrame =>
  ({
    frame: FIGPLUGIN_BRIDGE_CHILD_FRAME,
    ...message
  }) as FigPluginBridgeChildFrame

/** Encode and validate one bounded IPC frame. */
export function encodeFigPluginBridgeChildFrame(message: FigPluginBridgeProcessMessage): string {
  const frame = figPluginBridgeChildFrameSchema.parse(withFrame(message))
  const encoded = JSON.stringify(frame)
  if (Buffer.byteLength(encoded, 'utf8') > FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES) {
    throw new Error('Bridge child frame exceeds limit')
  }
  return encoded
}

/** Decode a single IPC frame. No concatenated, object, or oversized values are accepted. */
export function decodeFigPluginBridgeChildFrame(
  value: unknown
): FigPluginBridgeChildFrame | undefined {
  if (typeof value !== 'string') return undefined
  if (Buffer.byteLength(value, 'utf8') > FIGPLUGIN_BRIDGE_CHILD_MAX_FRAME_BYTES) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    const result = figPluginBridgeChildFrameSchema.safeParse(parsed)
    if (!result.success) return undefined
    // Bootstrap/shutdown frames are authority envelopes. Reject alternate
    // whitespace, key ordering and escaped encodings after schema parsing so
    // the schema's fixed key order defines the canonical representation.
    return JSON.stringify(result.data) === value ? result.data : undefined
  } catch {
    return undefined
  }
}

export function frameForBootstrap(input: {
  origin: string
  protocol: typeof FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL
  nonce: string
}): string {
  return encodeFigPluginBridgeChildFrame({ kind: 'bootstrap', ...input })
}

export function frameForReady(input: {
  origin: string
  protocol: typeof FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL
  nonce: string
}): string {
  return encodeFigPluginBridgeChildFrame({ kind: 'ready', ...input })
}

export function frameForShutdown(input: {
  origin: string
  protocol: typeof FIGPLUGIN_BRIDGE_PROCESS_PROTOCOL
  nonce: string
  reason: 'supervisor-stop'
}): string {
  return encodeFigPluginBridgeChildFrame({ kind: 'shutdown', ...input })
}
