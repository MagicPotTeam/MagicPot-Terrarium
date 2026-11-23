import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Box } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline'
import { useTranslation } from 'react-i18next'
import type { AgentRouteLike } from '@shared/agent'
import {
  AGENT_THREAD_INTERACTION_LIMITS as LIMITS,
  type AgentThreadInteraction,
  type AgentThreadInteractionAnswer,
  isAgentThreadInteractionExpired
} from '@shared/api/agentThreadInteraction'
import {
  formatToolCallValue,
  formatToolCardField,
  getToolCardActionStyle,
  getToolCardIcon
} from '../chatToolCallDisplay'
import { getAgentColumnTokens } from '../../../components/agentColumnTokens'
import AgentThreadAppDisplay from './AgentThreadAppDisplay'
import AgentThreadCardBody from './AgentThreadCardBody'
import AgentThreadCardActions from './AgentThreadCardActions'
import { isAgentThreadCardLinkAction } from '@shared/api/agentThreadCardDisplay'
import {
  ChatPromptCard,
  type ChatPromptCardAccent,
  type ChatPromptCardOption,
  type ChatPromptCardResolution
} from './ChatPromptCard'
import { api } from '../../../utils/windowUtils'

type PromptItem = AgentThreadInteraction & {
  prompt: Exclude<AgentThreadInteraction['prompt'], { kind: 'show_app' }>
}

/** The accents a card may ask for; anything else is the neutral card. */
const cardAccent = (accent: unknown): ChatPromptCardAccent => {
  switch (accent) {
    case 'primary':
    case 'info':
    case 'success':
    case 'warning':
    case 'danger':
      return accent
    default:
      return 'neutral'
  }
}

const fieldsSx = { display: 'grid', gap: '4px 12px', my: '8px', px: '4px' } as const

/**
 * One question of the agent as a prompt card: ask_user (a reply field) or show_card (a card with
 * its buttons). Once answered it stays, dimmed, with the state and the reply instead of controls.
 */
function PromptCard({
  item,
  onResolve,
  onExpired,
  resolution
}: {
  item: PromptItem
  onResolve?(answer: AgentThreadInteractionAnswer): Promise<void>
  onExpired?(): void
  resolution?: ChatPromptCardResolution
}) {
  const { t } = useTranslation()
  const theme = useTheme()
  const tokens = React.useMemo(() => getAgentColumnTokens(theme), [theme])
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const sending = useRef(false)
  const mounted = useRef(false)
  const expiredRef = useRef(onExpired)
  expiredRef.current = onExpired
  useEffect(() => {
    mounted.current = true
    if (resolution)
      return () => {
        mounted.current = false
      }
    // An open-ended prompt (no timeout_s) never expires on the client.
    const timer =
      item.expiresAt === null
        ? undefined
        : setTimeout(() => expiredRef.current?.(), Math.max(0, item.expiresAt - Date.now()))
    return () => {
      mounted.current = false
      clearTimeout(timer)
    }
  }, [item.expiresAt, resolution])
  const resolve = async (value: AgentThreadInteractionAnswer) => {
    if (!onResolve || sending.current || isAgentThreadInteractionExpired(item)) return
    sending.current = true
    setBusy(true)
    setError(false)
    try {
      await onResolve(value)
    } catch {
      if (mounted.current) setError(true)
    } finally {
      sending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const prompt = item.prompt
  const disabled = busy || Boolean(resolution)
  const errorLine = error ? (
    <Box
      role="alert"
      sx={{
        mb: '8px',
        px: '4px',
        fontSize: tokens.fontSize.small,
        lineHeight: '18px',
        color: tokens.danger,
        overflowWrap: 'anywhere'
      }}
    >
      {t('chat.agent_interaction.failed')}
    </Box>
  ) : null

  if (prompt.kind === 'ask_user') {
    const submit = () => {
      if (answer.trim()) void resolve({ status: 'answered', text: answer })
    }
    const fieldSx = {
      display: 'block',
      boxSizing: 'border-box',
      width: '100%',
      minWidth: '4rem',
      m: 0,
      padding: '6px 8px',
      border: `1px solid ${tokens.border}`,
      borderRadius: `${tokens.radius.control}px`,
      bgcolor: 'transparent',
      color: tokens.text,
      font: 'inherit',
      fontSize: tokens.fontSize.base,
      lineHeight: '20px',
      outline: 'none',
      '&:focus': { borderColor: tokens.accent },
      '&:disabled': { opacity: tokens.disabledOpacity },
      '&::placeholder': { color: tokens.muted, opacity: 1 }
    } as const
    const field = prompt.multiline ? (
      <Box
        component="textarea"
        rows={3}
        value={answer}
        disabled={disabled}
        aria-label={t('chat.agent_interaction.answer')}
        placeholder={prompt.placeholder ?? t('chat.agent_interaction.reply_placeholder')}
        maxLength={LIMITS.answer}
        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setAnswer(event.target.value)}
        sx={{ ...fieldSx, maxHeight: 240, resize: 'vertical' }}
      />
    ) : (
      <Box
        component="input"
        type="text"
        value={answer}
        disabled={disabled}
        aria-label={t('chat.agent_interaction.answer')}
        placeholder={prompt.placeholder ?? t('chat.agent_interaction.reply_placeholder')}
        maxLength={LIMITS.answer}
        autoComplete="off"
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAnswer(event.target.value)}
        onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          submit()
        }}
        sx={fieldSx}
      />
    )
    return (
      <ChatPromptCard
        testId="agent-prompt-card"
        icon={<ChatBubbleOutlineIcon aria-hidden="true" />}
        title={t('chat.agent_interaction.input_requested')}
        titleColor={tokens.accent}
        prompt={
          <Box component="span" sx={{ whiteSpace: 'pre-wrap', fontWeight: 400 }}>
            {prompt.question}
          </Box>
        }
        resolution={resolution}
        options={[
          {
            key: 'submit',
            label: t('chat.agent_interaction.submit'),
            primary: true,
            disabled: disabled || !answer.trim(),
            onSelect: submit
          },
          {
            key: 'cancel',
            label: t('chat.agent_interaction.cancel'),
            disabled,
            onSelect: () => void resolve({ status: 'dismissed' })
          }
        ]}
        leadingControl={field}
      >
        {errorLine}
      </ChatPromptCard>
    )
  }

  const icon = Object.hasOwn(prompt, 'icon') ? getToolCardIcon(prompt.icon) : undefined
  const anyInline = prompt.fields?.some((field) => field.inline) ?? false
  // Upstream's card offers only its own actions; Stop and expiry end the wait otherwise.
  // Link actions open their url and never answer, so they are not reply options.
  const options: ChatPromptCardOption[] = prompt.actions
    .filter((action) => !isAgentThreadCardLinkAction(action))
    .map((action): ChatPromptCardOption => {
    const style = getToolCardActionStyle(Object.hasOwn(action, 'style') ? action.style : undefined)
    return {
      key: `action:${action.id}`,
      label: action.label,
      primary: style?.variant === 'contained',
      danger: style?.color === 'error',
      disabled,
      onSelect: () => void resolve({ status: 'answered', actionId: action.id })
    }
  })
  const body = (
    <>
      {prompt.body ? (
        <Box sx={{ px: '4px', '& > div': { my: '8px' } }}>
          <AgentThreadCardBody body={prompt.body} />
        </Box>
      ) : null}
      {prompt.fields ? (
        <Box
          sx={{
            ...fieldsSx,
            gridTemplateColumns: anyInline ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)'
          }}
        >
          {prompt.fields.map((field, index) => (
            <Box
              key={index}
              sx={{
                minWidth: 0,
                gridColumn: field.inline ? undefined : '1 / -1',
                fontSize: tokens.fontSize.small,
                lineHeight: '18px',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere'
              }}
            >
              {formatToolCardField(field.label, field.value)}
            </Box>
          ))}
        </Box>
      ) : null}
      {prompt.footer !== undefined ? (
        <Box
          sx={{
            mt: '8px',
            mb: '8px',
            px: '4px',
            fontSize: tokens.fontSize.micro,
            lineHeight: '14px',
            fontStyle: 'italic',
            color: tokens.muted,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere'
          }}
        >
          {formatToolCallValue(prompt.footer).text}
        </Box>
      ) : null}
      <AgentThreadCardActions actions={prompt.actions} linksOnly />
      {errorLine}
    </>
  )
  return (
    <ChatPromptCard
      testId="agent-prompt-card"
      accent={cardAccent(Object.hasOwn(prompt, 'accent') ? prompt.accent : undefined)}
      title={
        <>
          {icon !== undefined ? (
            <Box component="span" aria-hidden="true" sx={{ mr: '6px' }}>
              {icon}
            </Box>
          ) : null}
          {prompt.title}
        </>
      }
      titleVariant="heading"
      aside={prompt.subtitle !== undefined ? formatToolCallValue(prompt.subtitle).text : undefined}
      body={body}
      resolution={resolution}
      options={options}
    />
  )
}

/** The reply a settled question shows under its prompt: the text or the chosen button. */
type SettledLabels = { answered: string; dismissed: string; expired: string }
function resolutionOf(
  item: PromptItem,
  answer: AgentThreadInteractionAnswer | 'expired',
  labels: SettledLabels
): ChatPromptCardResolution {
  if (answer === 'expired') return { state: labels.expired }
  if (answer.status === 'dismissed') return { state: labels.dismissed }
  if ('text' in answer) return { state: labels.answered, reply: answer.text }
  if ('actionId' in answer && item.prompt.kind === 'show_card') {
    const action = item.prompt.actions.find((entry) => entry.id === answer.actionId)
    return { state: labels.answered, reply: action?.label ?? answer.actionId }
  }
  return { state: labels.answered }
}

/** Settled questions stay on screen, at most this many per conversation. */
const SETTLED_CARDS_KEPT = 8
/** Conversations whose settled questions a panel remembers after their run ended. */
const SETTLED_SCOPES_KEPT = 16

type SettledCard = { item: PromptItem; resolution: ChatPromptCardResolution }

/** The prompt cards at the end of the transcript: the settled ones, then the open one. */
function PromptCards({
  scope,
  settledCards,
  current,
  host
}: {
  scope: string
  settledCards: readonly SettledCard[]
  current?: React.ReactNode
  host?: HTMLElement | null
}) {
  const cards = (
    <Box
      data-testid="agent-prompt-cards"
      sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
    >
      {settledCards.map((entry) => (
        <PromptCard
          key={`${scope}:${entry.item.id}:settled`}
          item={entry.item}
          resolution={entry.resolution}
        />
      ))}
      {current}
    </Box>
  )
  if (host === undefined) return cards
  return host ? createPortal(cards, host) : null
}

function ActiveThreadInteractions({
  scope,
  host,
  onSettled
}: {
  scope: string
  host?: HTMLElement | null
  onSettled(cards: readonly SettledCard[]): void
}) {
  const { t } = useTranslation()
  const [pending, setPending] = useState<{ scope: string; item: AgentThreadInteraction }>()
  const [settledCards, setSettledCards] = useState<SettledCard[]>([])
  const settledCardsRef = useRef<SettledCard[]>([])
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled
  const settled = useRef(new Set<string>())
  const live = useRef(false)
  const item = pending?.scope === scope ? pending.item : undefined

  // A new run (or a new activation) starts with no settled cards; those of the run before it
  // leave the transcript tail here, where newer turns now follow them.
  useEffect(() => {
    onSettledRef.current([])
  }, [])

  useEffect(() => {
    live.current = true
    const service = api().svcLLMProxy
    // Older hosts and test adapters may not implement this UI surface yet.
    if (typeof service?.listAgentInteractions !== 'function') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const request = JSON.parse(scope)
    const poll = async () => {
      try {
        const result = await service.listAgentInteractions(request)
        if (stopped) return
        const next = result.interactions.find(
          (entry) => !settled.current.has(entry.id) && !isAgentThreadInteractionExpired(entry)
        )
        setPending((previous) =>
          next
            ? previous?.scope === scope && previous.item.id === next.id
              ? previous
              : { scope, item: next }
            : undefined
        )
      } catch {
        // A transport hiccup is not proof that the prompt was revoked. Keep its
        // keyed draft; successful empty polls, expiry and scope changes remove it.
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 500)
      }
    }
    void poll()
    return () => {
      stopped = true
      live.current = false
      clearTimeout(timer)
    }
  }, [scope])

  const settle = (
    selected: AgentThreadInteraction,
    answer: AgentThreadInteractionAnswer | 'expired'
  ) => {
    settled.current.add(selected.id)
    if (settled.current.size > 128) settled.current.delete(settled.current.values().next().value!)
    setPending((previous) =>
      previous?.scope === scope && previous.item.id === selected.id ? undefined : previous
    )
    // An app display leaves when it is settled; a question card stays with its answer.
    if (selected.prompt.kind !== 'show_app') {
      const card = selected as PromptItem
      const next = [
        ...settledCardsRef.current.filter((entry) => entry.item.id !== card.id),
        {
          item: card,
          resolution: resolutionOf(card, answer, {
            answered: t('chat.agent_interaction.state_answered'),
            dismissed: t('chat.agent_interaction.state_dismissed'),
            expired: t('chat.agent_interaction.state_expired')
          })
        }
      ].slice(-SETTLED_CARDS_KEPT)
      settledCardsRef.current = next
      setSettledCards(next)
      onSettledRef.current(next)
    }
  }
  let current: React.ReactNode = null
  if (item) {
    const selected = item
    const resolve = async (answer: AgentThreadInteractionAnswer) => {
      await api().svcLLMProxy.resolveAgentInteraction({
        ...JSON.parse(scope),
        interactionId: selected.id,
        answer
      })
      if (!live.current) return
      settle(selected, answer)
    }
    current =
      selected.prompt.kind === 'show_app' ? (
        <AgentThreadAppDisplay
          key={`${scope}:${selected.id}`}
          document={selected.prompt.document}
          expiresAt={selected.expiresAt}
          onResolve={resolve}
        />
      ) : (
        <PromptCard
          key={`${scope}:${selected.id}`}
          item={selected as PromptItem}
          onResolve={resolve}
          onExpired={() => {
            if (live.current) settle(selected, 'expired')
          }}
        />
      )
  }
  if (!current && !settledCards.length) return null
  return <PromptCards scope={scope} settledCards={settledCards} current={current} host={host} />
}

/**
 * The agent's questions to the person (ask_user, show_card) and its app displays (show_app), as
 * cards at the end of the transcript. `host` is the element at the end of the transcript that
 * takes them; without it they are drawn in place. Mount a fresh channel for every
 * scope/activation: late replies never reach its successor. When the run ends, its answered,
 * cancelled and expired cards stay, dimmed with their state, as upstream's do; they leave when
 * the conversation's next run starts.
 */
export default function AgentThreadInteractionPanel({
  route,
  conversationId,
  active,
  host
}: {
  route?: AgentRouteLike
  conversationId?: string
  active: boolean
  host?: HTMLElement | null
}) {
  const settledByScope = useRef(new Map<string, readonly SettledCard[]>())
  if (route?.channel !== 'canvas' || route.scopeType !== 'thread' || !conversationId) return null
  const scope = JSON.stringify({ route, conversationId })
  if (!active) {
    const settledCards = settledByScope.current.get(scope)
    return settledCards?.length ? (
      <PromptCards scope={scope} settledCards={settledCards} host={host} />
    ) : null
  }
  const keepSettled = (cards: readonly SettledCard[]) => {
    const kept = settledByScope.current
    kept.delete(scope)
    if (cards.length) kept.set(scope, cards)
    while (kept.size > SETTLED_SCOPES_KEPT) kept.delete(kept.keys().next().value!)
  }
  return <ActiveThreadInteractions key={scope} scope={scope} host={host} onSettled={keepSettled} />
}
