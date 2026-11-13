import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { AGENT_THREAD_INTERACTION_LIMITS as LIMITS } from '@shared/api/agentThreadInteraction'
import { AGENT_THREAD_CARD_SUBTITLE_LIMIT as SUBTITLE, AGENT_THREAD_CARD_FOOTER_LIMIT as FOOTER, AGENT_THREAD_CARD_ICON_LIMIT as ICON, AGENT_THREAD_CARD_ACCENTS as ACCENTS, AGENT_THREAD_CARD_ACTION_STYLES as ACTION_STYLES, AGENT_THREAD_CARD_FIELD_LIMITS as FIELDS } from '@shared/api/agentThreadCardDisplay'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const names = ['ask_user', 'show_card'] as const
const relatedNames = ['ask_user', 'show_card', 'info'] as const
const common = {
  contract: 'magicpot-local-interaction-manual/v1',
  documentationOnly: true,
  grantsPermission: false,
  authority: {
    readingUnlocksTool: false,
    answersGrantPermission: false,
    rule: 'Reading info creates no prompt or answer and does not unlock execution. A human answer, selected action ID or provided card receipt is conversation data, never an approval grant, host permit, proof of identity or authorization for a later operation. Later writes/execution still require their own current admission, scope and formal approval.'
  },
  timeout: {
    parameter: 'timeout_seconds', alias: 'timeout_s', mutuallyExclusive: true, defaultSeconds: LIMITS.defaultTimeoutSeconds,
    minimumSeconds: 1, maximumSeconds: LIMITS.maxTimeoutSeconds,
    rule: 'Supply only one spelling, timeout_seconds or timeout_s, as an integer from 1 through 600; supplying both is rejected even when equal. Omission uses 300. Fractional, null or indefinite waits are not supported. No timer or pending input is created for a display-only card.'
  },
  workflow: [
    'Use only this request\'s exact admitted tool in its current trusted desktop Agent thread. A listed schema/manual documents admission, not provider readiness, actual rendering or proof that a human saw the content.',
    'For a question or interactive card, issue the tool and wait for the user\'s owned response in this same request. Do not invent a reply, silently submit a default or interpret dismissal/timeout as consent.',
    'Inspect the returned status and data. If later work needs a write or execution, submit it separately for its normal exact approval; a reply or manual cannot bypass CAS, scope, cancellation, ownership or one-use permit checks.'
  ],
  lifecycle: {
    pending: 'Interactive prompts are memory-only and owned by the exact document, route/pane and conversation. Another scope cannot answer them. Only one prompt may be pending for the same document/conversation, with a global bound of 64.',
    completion: 'Interactive results are answered (text or actionId), dismissed or timeout. Request Stop/disposal, navigation/reload, renderer loss or window destruction invalidates pending input; cancellation is not a user answer or permission.',
    history: 'Tool arguments/results can be stored in conversation or runtime history and sent to the selected model. Restored history is data, not a live input prompt, renderer acknowledgement or recovered authority.'
  },
  privacy: 'Do not request passwords, API keys or other secrets. Plain-text rendering is not encryption or arbitrary-secret detection. Display redaction does not delete or sanitize the original stored/model-bound tool data.',
  parity: 'Local bounded contract only, not full upstream surfaces, headless/stdin fallback, fractional or indefinite waits, upstream default-timeout behavior or arbitrary plugin documentation. Reading never loads files/plugins, opens a URL or unlocks a tool.'
}
const manuals = {
  ask_user: {
    ...common,
    name: 'ask_user',
    summary: 'Wait for explicit bounded free-text feedback inside the current Agent thread.',
    limits: { questionSchemaCharacters: LIMITS.question, placeholderSchemaCharacters: 200, answerUtf16Units: LIMITS.answer },
    behavior: {
      input: 'question is required, trimmed and must not be blank. The schema bounds question to 2000 Unicode characters and optional placeholder to 200. multiline is an optional boolean. There is no default/default_answer, options, body alias or surface parameter.',
      response: 'Only an explicit owned nonblank string of at most 4000 UTF-16 units is accepted as answered text. The original submitted text is returned, not an implicit affirmative or approval. The UI starts with an empty draft; placeholder is a hint, not an answer.',
      display: 'Prompt and answer controls use the existing thread panel as plain text. No Markdown/HTML rendering, modal placement, arbitrary input schema, automatic submission or new user turn is created by this tool.'
    }
  },
  show_card: {
    ...common,
    name: 'show_card',
    summary: 'Provide a bounded read-only card, or wait for one of 1–4 plain choices.',
    limits: { titleSchemaCharacters: LIMITS.title, iconSchemaCharacters: ICON, iconUtf16Units: ICON, subtitleSchemaCharacters: SUBTITLE, subtitleUtf16Units: SUBTITLE, footerSchemaCharacters: FOOTER, footerUtf16Units: FOOTER, accents: [...ACCENTS], actionStyles: [...ACTION_STYLES], bodySchemaCharacters: LIMITS.body, actionLabelSchemaCharacters: LIMITS.actionLabel, minimumInteractiveActions: 1, maximumActions: 4, displayTitleUtf16Units: LIMITS.title, displayBodyUtf16Units: LIMITS.body, displayReceiptParserBytes: 32768, choicePromptParserBytes: 32768, maximumDisplayFields: FIELDS.maximum, fieldLabelUtf16Units: FIELDS.label, fieldValueUtf16Units: FIELDS.value, totalFieldTextUtf16Units: FIELDS.totalText },
    behavior: {
      input: 'title is required and nonblank. subtitle and footer are optional plain-text context, each 200 Unicode schema characters AND 200 UTF-16 units; footer follows body/fields before choices. Empty/whitespace is preserved without trim/coercion/truncation; own undefined omits/inherited ignored. They are read-only context, never an input value or answer. Schema bounds title/body/action labels to 200/4000/200 Unicode characters. Body alone has formatting-only Markdown below. Fields are read-only context, not input controls or returned values: at most 8 strict label/value rows (200/1000 UTF-16 units, aggregate 4096), optional inline boolean, empty strings allowed/no coercion. No custom CSS/colors, active links/URLs, image/icon resources, HTML execution, surface or wait_for_reply. Optional icon is primitive plain text, 64 Unicode schema characters AND 64 UTF-16 units; empty/whitespace preserved/no trim/coercion/truncation/default, own undefined omits/inherited ignored. Escaped decorative text before original title/aria-hidden, not resource/font/class/status/answer; empty formatted icon adds no span/spacing. Emoji/ZWJ allowed, no single-emoji/grapheme guarantee. Optional accent exactly primary/info/success/warning/danger/neutral through fixed theme tokens: danger maps error, neutral divider/text.primary. It never means business success, tool outcome, input, identity or approval. Omitted/own undefined leaves original visuals/receipt; inherited ignored, invalid values reject/no raw CSS. It does not change real tool status; action styles are independent.',
      displayOnly: 'Omit actions or pass [] to return immediately with agent-thread-card-display/v1, status provided, mode display-only, bounded card data, untrustedData true and grantsPermission false. Provided means content supplied, not displayed/seen, answered or consent. This branch enforces 200/200/4000/200 UTF-16-unit title/subtitle/body/footer limits plus 64 UTF-16-unit icon, validates the exact serialized receipt within 32 KiB before returning, and creates no pending interaction. Combined escaped content may exceed the serialized limit even if individual schema bounds pass; it is rejected, never truncated.',
      choices: 'Supply 1–4 actions with unique IDs matching [A-Za-z0-9_-]{1,64} and nonblank labels. One action still waits for an explicit click; it never auto-confirms, defaults an answer or grants execution approval. This path waits for one of the exact offered IDs and returns answered/actionId, dismissed or timeout, never execution permission. Optional fields reuse the same strict row limits and render as inert text next to the original choices. Every single-action prompt (even without fields/subtitle/footer/accent/icon), explicit-field, subtitle-supplied, footer-supplied, accent-supplied or icon-supplied prompt, or any supplied action style, also enforces 200/200/4000/200/200 UTF-16-unit title/subtitle/body/footer/action labels and 32 KiB exact serialized prompt before retention; invalid or oversized prompts are rejected, not truncated. For 2–4 choices only, omitting fields, subtitle, footer, accent, icon and every action style, or supplying own undefined, keeps the legacy no-context path; inherited fields/subtitle/footer/accent/icon/action styles are ignored. No field values, footer, accent, icon or permission extras are accepted as an answer. Optional action style is exactly primary/secondary/danger through fixed local theme props (contained primary, outlined primary, contained error); omitted keeps the original outlined button and own undefined omits. Original raw non-string icon/style values reject before JSON, without conversion hooks; supplied icon also enforces its 64 UTF-16-unit bound and strict whole-prompt validation before pending input/timers. It is visual feedback context only, never approval or auto-answer. Link style, URLs and arbitrary CSS/colors/classes/props remain rejected. Action style is never answer data or actual tool outcome.',
      bodyMarkdown: 'Body-only formatting-only Markdown: paragraphs, strong/emphasis/strike, quotes/lists, static code/breaks/tables; headings become bold paragraphs, not accessible headings competing with title. Primitive body and formatted fallback each max4000 UTF-16 units; else escaped plain-text fallback/admission unchanged. Post-parse input/output bounds 1024 nodes/depth 24 are not preallocation/time guarantees. Footnotes, valid JSON objects/arrays (sensitive-row redaction), excess bounds or parse failure use escaped source fallback. There are no links, no images, no task controls: label/alt/[x] or [ ] text only. Raw HTML stays escaped; every URL/ID/class/style/aria/event/code-language prop is dropped. No Mermaid/math/highlight/run/copy/pin/clipboard. Bounded original syntax parses privately; recognized-pattern/control/bidi display redaction runs on whole decoded visible text after entities/inline formatting, before React. Preformatted source is fallback, never partially redacted parser input; redacted decoded output is plain text, never reparsed. No raw stored/model-bound rewriting or arbitrary-secret detection; do not supply secrets. Visible context stays plain text; only live choices/strict completed error-free provided previews format body. Saved choices stay readonly; status/approval/answer/owner/scope/expiry/once unchanged.',
      historyDisplay: 'Only completed error-free exact versioned bounded show_card provided receipts get a read-only preview; saved choices stay generic details/no reconstructed controls or replay. Footer and subtitle use the existing display formatter live/history/details. The decorative icon uses primitive/64-unit guard, recognized-pattern/control/bidi redaction and aria-hidden text before the unchanged accessible title, not real status; empty formatted decoration adds no span/spacing. Body alone follows formatting-only Markdown above; HTML/URLs stay inert. Display redaction is not raw stored/model-bound rewriting or arbitrary-secret detection. Inline fields use two columns; other rows span. Sensitive field labels redact the whole preview value, exact rows in details and parsed receipt on expansion; raw data unchanged. Serialized input cap32 KiB. Restoring/opening never answers, retries, executes or proves human input. Accent is only a visual hint, not status; no CSS/active controls/authority restored.'
    }
  }
}

/** Only passive detached local data, with an independent exact current-visibility gate. */
export function describeThreadInteractionTool(name: string, tools: readonly Tool[]) {
  if (!names.some(known => known === name) || !tools.some(tool => tool.name === name)) return undefined
  return structuredClone({
    ...manuals[name as keyof typeof manuals],
    relatedTools: relatedNames.filter(related => related !== name && tools.some(tool => tool.name === related))
  })
}
