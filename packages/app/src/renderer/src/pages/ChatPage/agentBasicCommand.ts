export type AgentBasicCommand = 'status' | 'jobs' | 'triggers' | 'compact' | 'video_gen'
export const isAgentBasicCommand = (text: string) => /^\/(?:status|jobs|triggers?|compact|video_gen)(?:\s|$)/i.test(text.trimStart())
export function parseAgentBasicCommand(text: string): AgentBasicCommand | undefined {
  if (!isAgentBasicCommand(text)) return undefined
  const match = /^\/(status|jobs|triggers?|compact|video_gen)$/i.exec(text.trim())
  if (!match) throw new Error('Use /status, /jobs, /triggers or /compact without arguments.')
  const command = match[1].toLowerCase()
  // KohakuTerrarium's /triggers also answers to /trigger.
  return (command === 'trigger' ? 'triggers' : command) as AgentBasicCommand
}
