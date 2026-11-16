import React from 'react'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import {
  BackgroundResultDivider,
  ChatCommandResultCard,
  CommandCardActions,
  CommandCardList,
  CommandCardNote,
  CommandCardPanelBody,
  CommandCardText,
  type CommandCardListItem
} from './ChatCommandCard'
import { ChatPromptCard, type ChatPromptCardResolution } from './ChatPromptCard'

type TailCardBase = {
  id: number
  /** The conversation the command ran in; a card is shown only there. */
  scope: string
  /** The command as typed, without arguments: "/status". */
  command: string
  /**
   * How many messages the conversation had when the command ran. The card keeps that place:
   * it follows the message `anchor - 1` (0: it comes before the first message), also when
   * newer messages arrive.
   */
  anchor: number
}

/** Where a link of a card leads; the page that owns the tail knows how to go there. */
export type ChatTailLink<Target> = { key: string; label: string; target: Target }

/** A row of a list card; its links act on that item (stop a job, read its result). */
export type ChatTailListItem<Target = unknown> = Omit<CommandCardListItem, 'actions'> & {
  links?: ChatTailLink<Target>[]
}

/**
 * One command card of the transcript: the result of a slash command. Cards are view state of
 * the open conversation; they are never stored.
 */
export type ChatTailCard<Target = unknown> =
  | (TailCardBase & {
      kind: 'text'
      title?: string
      text: string
      /** Raw output: monospace. */
      mono?: boolean
      muted?: boolean
      error?: boolean
      /** One muted line under the text. */
      note?: string
    })
  | (TailCardBase & { kind: 'list'; title?: string; items: ChatTailListItem<Target>[] })
  | (TailCardBase & { kind: 'links'; text: string; links: ChatTailLink<Target>[] })
  | (TailCardBase & {
      /** A command that asks before it acts: a prompt card with a default and a cancel button. */
      kind: 'confirm'
      title: string
      prompt: string
      detail?: string
      confirmLabel: string
      cancelLabel: string
      /** Set once the person has answered; the card then stays, dimmed, with the reply. */
      resolution?: ChatPromptCardResolution
    })

  | (TailCardBase & {
      /**
       * A live view of the conversation (goal records, thread skills) inside a card. The page
       * that owns the cards draws the view into an element of its own, which the card's body
       * takes in. There is one card per panel: running its command again moves the card to
       * the end.
       */
      kind: 'panel'
      panel: string
      title?: string
    })
  | (TailCardBase & {
      /** A background job or process of the conversation finished: a divider with the text. */
      kind: 'background'
      text: string
    })

export type ChatTailConfirmCard = Extract<ChatTailCard, { kind: 'confirm' }>

/** A card as the page creates it; the owner of the cards adds the id, the scope and the anchor. */
export type ChatTailCardDraft<Target = unknown> =
  ChatTailCard<Target> extends infer Card
    ? Card extends TailCardBase
      ? Omit<Card, 'id' | 'scope' | 'anchor'>
      : never
    : never

/**
 * The body of a panel card. It takes in the element that holds the view. The element belongs
 * to the owner of the cards, so the view inside keeps its state when the card is drawn again
 * at another place of the transcript (a newer message arrived, the row left the window of a
 * long transcript and came back).
 */
const PanelCardBody: React.FC<{ host: HTMLElement | undefined }> = ({ host }) => {
  const bodyRef = React.useRef<HTMLDivElement | null>(null)
  React.useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || !host) return
    body.appendChild(host)
    return () => {
      if (host.parentNode === body) body.removeChild(host)
    }
  }, [host])
  return <CommandCardPanelBody ref={bodyRef} />
}

/** Command cards of the Agent column's transcript that stand at one place, in order. */
export function ChatCommandTail<Target>({
  cards,
  onLink,
  onAnswer,
  panelHosts
}: {
  cards: readonly ChatTailCard<Target>[]
  onLink: (target: Target) => void
  /** The person chose the default button (`confirmed`) or cancel on a confirm card. */
  onAnswer: (card: ChatTailConfirmCard, confirmed: boolean) => void
  /** The element of each panel's view, by panel name; the card of the panel shows it. */
  panelHosts: Readonly<Record<string, HTMLElement | undefined>>
}): React.ReactElement {
  return (
    <>
      {cards.map((card) => {
        if (card.kind === 'panel') {
          // Keyed by the panel, not by the card: the view inside keeps its state when the
          // command is run again and the card moves to the end.
          return (
            <ChatCommandResultCard
              key={`panel:${card.panel}`}
              command={card.command}
              title={card.title}
              fill
            >
              <PanelCardBody host={panelHosts[card.panel]} />
            </ChatCommandResultCard>
          )
        }
        if (card.kind === 'background') {
          return <BackgroundResultDivider key={card.id} text={card.text} />
        }
        if (card.kind === 'confirm') {
          return (
            <ChatPromptCard
              key={card.id}
              testId="chat-command-confirm-card"
              command={card.command}
              icon={<WarningAmberIcon aria-hidden="true" />}
              accent="warning"
              title={card.title}
              prompt={card.prompt}
              detail={card.detail}
              resolution={card.resolution}
              options={[
                {
                  key: 'confirm',
                  label: card.confirmLabel,
                  primary: true,
                  onSelect: () => onAnswer(card, true)
                },
                { key: 'cancel', label: card.cancelLabel, onSelect: () => onAnswer(card, false) }
              ]}
            />
          )
        }
        if (card.kind === 'text') {
          return (
            <ChatCommandResultCard
              key={card.id}
              command={card.command}
              title={card.title}
              error={card.error}
            >
              <CommandCardText mono={card.mono} muted={card.muted} error={card.error}>
                {card.text}
              </CommandCardText>
              {card.note ? <CommandCardNote>{card.note}</CommandCardNote> : null}
            </ChatCommandResultCard>
          )
        }
        if (card.kind === 'list') {
          return (
            <ChatCommandResultCard key={card.id} command={card.command} title={card.title}>
              <CommandCardList
                items={card.items.map(({ links, ...item }) => ({
                  ...item,
                  actions: links?.map((link) => ({
                    key: link.key,
                    label: link.label,
                    onClick: () => onLink(link.target)
                  }))
                }))}
              />
            </ChatCommandResultCard>
          )
        }
        return (
          <ChatCommandResultCard key={card.id} command={card.command}>
            <CommandCardText muted>{card.text}</CommandCardText>
            <CommandCardActions
              actions={card.links.map((link) => ({
                key: link.key,
                label: link.label,
                onClick: () => onLink(link.target)
              }))}
            />
          </ChatCommandResultCard>
        )
      })}
    </>
  )
}

export default ChatCommandTail
