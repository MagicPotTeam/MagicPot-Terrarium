export type AgentBasicCommand = 'status' | 'jobs' | 'compact' | 'video_gen'
export const isAgentBasicCommand = (text: string) => /^\/(?:status|jobs|compact|video_gen)(?:\s|$)/i.test(text.trimStart())
export function parseAgentBasicCommand(text: string): AgentBasicCommand | undefined {
  if (!isAgentBasicCommand(text)) return undefined
  const match = /^\/(status|jobs|compact|video_gen)$/i.exec(text.trim())
  if (!match) throw new Error('Use /status, /jobs or /compact without arguments.')
  return match[1].toLowerCase() as AgentBasicCommand
}
