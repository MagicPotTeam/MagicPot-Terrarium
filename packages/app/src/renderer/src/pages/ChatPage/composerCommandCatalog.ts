import type enLocale from '@shared/locales/en-US/renderer.json'

/**
 * The one list of slash commands the composer may suggest. Parsing and execution stay in the
 * per-command modules and ChatPage; composerCommandCatalog.test.ts fails when the two drift apart.
 */
export type ComposerCommandContext = {
  /** The remote LLM service is in use instead of a locally configured model. */
  remote: boolean
  /** The conversation is a canvas Agent thread. */
  canvasThread: boolean
  /** The working-notes view of this conversation accepts a command right now. */
  scratchpad: boolean
  /** The selected skill has tools that can be called directly. */
  boundTools: boolean
  /** The conversation belongs to a team member rather than the lead. */
  teamMember: boolean
}

type ComposerSuggestionText = keyof (typeof enLocale)['chat']['composer_suggestions']
/** Locale keys of the popup texts, so a missing string is a compile error. */
export type ComposerSuggestionTextKey = `chat.composer_suggestions.${ComposerSuggestionText}`

export type ComposerCommand = {
  /** Without the leading slash. */
  name: string
  /** Other spellings the parser accepts; suggested only when the typed prefix matches them. */
  aliases?: readonly string[]
  /** Present only when the command takes arguments. */
  argumentHintKey?: ComposerSuggestionTextKey
  descriptionKey: ComposerSuggestionTextKey
  /** Mirrors the context checks ChatPage applies before it runs the command. */
  available: (context: ComposerCommandContext) => boolean
}

const key = <Name extends ComposerSuggestionText>(name: Name) =>
  `chat.composer_suggestions.${name}` as const
const always = () => true
const local = (context: ComposerCommandContext) => !context.remote
const localThread = (context: ComposerCommandContext) => !context.remote && context.canvasThread

export const COMPOSER_COMMANDS: readonly ComposerCommand[] = [
  { name: 'status', descriptionKey: key('command_status'), available: always },
  { name: 'jobs', descriptionKey: key('command_jobs'), available: localThread },
  {
    name: 'compact',
    descriptionKey: key('command_compact'),
    available: (context) => !context.teamMember
  },
  {
    name: 'btw',
    argumentHintKey: key('hint_btw'),
    descriptionKey: key('command_btw'),
    available: localThread
  },
  {
    name: 'skill',
    aliases: ['skills'],
    argumentHintKey: key('hint_skill'),
    descriptionKey: key('command_skill'),
    available: localThread
  },
  {
    name: 'scratchpad',
    aliases: ['pad'],
    descriptionKey: key('command_scratchpad'),
    available: (context) => localThread(context) && context.scratchpad
  },
  { name: 'branch', descriptionKey: key('command_branch'), available: local },
  { name: 'regen', descriptionKey: key('command_regen'), available: local },
  {
    name: 'edit',
    argumentHintKey: key('hint_edit'),
    descriptionKey: key('command_edit'),
    available: local
  },
  {
    name: 'repair-images',
    aliases: ['repair_images'],
    descriptionKey: key('command_repair_images'),
    available: local
  },
  { name: 'env', descriptionKey: key('command_env'), available: always },
  { name: 'system_prompt', descriptionKey: key('command_system_prompt'), available: always },
  {
    name: 'plugin',
    argumentHintKey: key('hint_configure'),
    descriptionKey: key('command_plugin'),
    available: always
  },
  {
    name: 'module',
    argumentHintKey: key('hint_configure'),
    descriptionKey: key('command_module'),
    available: always
  },
  { name: 'video_gen', descriptionKey: key('command_video_gen'), available: always },
  {
    name: 'tool',
    argumentHintKey: key('hint_tool'),
    descriptionKey: key('command_tool'),
    available: (context) => context.boundTools && !context.teamMember
  }
]

export const listComposerCommands = (context: ComposerCommandContext): ComposerCommand[] =>
  COMPOSER_COMMANDS.filter((command) => command.available(context))
