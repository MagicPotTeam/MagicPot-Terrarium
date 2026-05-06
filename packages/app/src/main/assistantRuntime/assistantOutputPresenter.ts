import type { AssistantRuntimeResult, AssistantRunEvent } from './types'

type AssistantProgressTextOptions = {
  queueLeadText?: 'received' | 'accepted'
  acknowledgedText?: string
  startedText?: string
}

const cleanString = (value?: string | null): string | undefined => {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

const ASSISTANT_COMMAND_LINES = [
  '/help - show this help',
  '/status - show current chat session status',
  '/queue - show queue and run state',
  '/cancel - request cancellation for the current task',
  '/continue <runId> <message> - continue a prior run as a follow-up run',
  '/resume <runId> - requeue a failed or cancelled run from its stored request text',
  '/cleanup [clear | prune <olderThanDays>] - clear this session or prune stale sessions',
  '/workspace - show workspace context',
  '/workspace <workspaceId> - inspect a recorded workspace identity',
  '/attach <workspaceId> [private|shared] - attach this route to a workspace identity',
  '/detach - detach this route back to its default workspace identity',
  '/share [workspaceId] - mark a workspace as shared (owner only)',
  '/privatize [workspaceId] - mark a workspace as private when no foreign routes remain attached (owner only)',
  '/archive [workspaceId] - archive a detached workspace identity (owner only)',
  '/revive [workspaceId] - revive an archived workspace identity (owner only)',
  '/workspaces - list recorded workspace identities',
  '/workflows - list persisted workflow records for this route',
  '/task - show task status and task-group summaries',
  '/task inspect <taskGroupId> - inspect a task-group workflow',
  '/task start <taskGroupId> | <title> | <description> - start or update task-group metadata',
  '/task progress <taskGroupId> | <label> | <completed> | <total> | <percent> - record task-group progress',
  '/task approve <taskGroupId> | <approvedBy> - mark a task-group as approved',
  '/task export <taskGroupId> | <exportTarget> | <artifactId,artifactId> - mark a task-group as exported',
  '/task cancel <taskGroupId> - cancel a task-group workflow',
  '/task resume <taskGroupId> - resume a task-group workflow',
  '/task retry <taskGroupId> - retry a task-group workflow via resume semantics',
  '/task replay <taskGroupId> - inspect replayable trace/lineage data for a task-group',
  '/tasks - alias for /task status',
  '/task-group ... - alias for /task',
  '/task-status - alias for /task status',
  '/session - show stored session summary',
  '/runs - show recent run records',
  '/events - show recent runtime events',
  '/artifacts - show recent recorded artifacts',
  '/ops - show derived operational status for this session',
  '/trace <runId> - show a correlated trace timeline for a run',
  '/lineage <runId> - show the related run chain for a run',
  '/workflow <workflowId> - show a persisted workflow inspection view',
  '/workflow-resume <workflowId> - requeue the latest resumable run in a persisted workflow record',
  '/pins - show pinned reusable context notes',
  '/pin <text> - pin a reusable note for later runs',
  '/unpin <index|noteId|all> - remove pinned notes',
  '/memory - show recent workspace memory',
  '/tools [name] - list available tools or inspect one tool',
  '/new - start a fresh conversation',
  '/reset - clear the stored conversation history',
  '/tool <name> [json] - call a registered tool'
] as const

const buildChannelTriggerHint = (channel?: string): string => {
  switch (cleanString(channel)?.toLowerCase()) {
    case 'telegram':
      return 'In private chats, send anything. In groups, mention MagicPot, reply to a previous MagicPot message, or use /command@botname.'
    case 'feishu':
      return 'In direct chats, send anything. In group chats, mention MagicPot before sending the first message.'
    case 'discord':
      return 'In direct messages, send anything. In servers, mention MagicPot or reply to a previous MagicPot message.'
    case 'qq':
      return 'Send the first message in an allowed QQ chat, group, or channel. Relay mode depends on the configured bridge.'
    case 'wechat':
      return 'Use the configured bridge or relay path first. Native mode depends on your existing iLink integration.'
    case 'imessage':
      return 'Use the configured bridge, relay, or local CLI integration. Relay mode depends on your external proxy.'
    default:
      return 'Use the configured external chat channel or relay entrypoint. The settings page is for configuration and inspection only.'
  }
}

export const buildAssistantProgressText = (
  event: AssistantRunEvent,
  options?: AssistantProgressTextOptions
): string | undefined => {
  const queueLeadText = options?.queueLeadText || 'received'

  switch (event.type) {
    case 'queued': {
      const queuePosition = Number(event.metadata?.queuePosition || 0)
      if (queuePosition > 1) {
        return `MagicPot queued your request. Position: ${queuePosition}.`
      }
      return queueLeadText === 'accepted'
        ? 'MagicPot accepted your request and is starting it now.'
        : 'MagicPot received your request.'
    }
    case 'acknowledged':
      return options?.acknowledgedText || 'MagicPot received your request.'
    case 'started':
      return options?.startedText || 'MagicPot is working on your request...'
    case 'progress':
      return cleanString(event.message)
    case 'cancelled':
      return 'The task was cancelled.'
    case 'failed':
      return `MagicPot error: ${event.message}`
    default:
      return undefined
  }
}

export const buildAssistantFinalText = (
  status?: AssistantRuntimeResult['status']
): string | undefined => {
  switch (status) {
    case 'completed':
      return 'MagicPot finished your request.'
    case 'cancelled':
      return 'The task was cancelled.'
    case 'failed':
      return 'MagicPot could not complete this request.'
    default:
      return undefined
  }
}

export const buildAssistantAttachmentsOnlyText = (): string => 'MagicPot sent attachments.'

export const buildAssistantEmptyReplyText = (): string => 'MagicPot returned an empty reply.'

export const splitAssistantTextChunks = (text: string, limit: number): string[] => {
  const normalized = cleanString(text)
  if (!normalized) return []
  if (!Number.isFinite(limit) || limit <= 0 || normalized.length <= limit) {
    return [normalized]
  }

  const chunks: string[] = []
  let remaining = normalized

  while (remaining.length > limit) {
    const paragraphBoundary = remaining.lastIndexOf('\n\n', limit)
    const lineBoundary = remaining.lastIndexOf('\n', limit)
    const wordBoundary = remaining.lastIndexOf(' ', limit)
    const boundary = [paragraphBoundary, lineBoundary, wordBoundary].find((value) => value >= 0)
    const sliceIndex = boundary && boundary > Math.floor(limit * 0.6) ? boundary : limit
    const nextChunk = remaining.slice(0, sliceIndex).trim()
    chunks.push(nextChunk || remaining.slice(0, limit))
    remaining = remaining.slice(sliceIndex).trim()
  }

  if (remaining) {
    chunks.push(remaining)
  }

  return chunks
}

export const buildAssistantHelpText = (channel?: string): string =>
  [
    'MagicPot bot is running.',
    '',
    'Onboarding:',
    'Use this bot from the external chat channel or relay entrypoint, not inside MagicPot settings.',
    `Trigger rule: ${buildChannelTriggerHint(channel)}`,
    'First message to try: /help',
    'Success check: the reply should include the Commands section plus entries such as /status and /tools.',
    '',
    'Commands:',
    ...ASSISTANT_COMMAND_LINES
  ].join('\n')
