import React from 'react'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import {
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
}

/** Where a link of a card leads; the page that owns the tail knows how to go there. */
export type ChatTailLink<Target> = { key: string; label: string; target: Target }

/**
 * One row of the transcript tail: the result of a slash command. Cards are view state of the
 * open conversation; they are never stored.
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
  | (TailCardBase & { kind: 'list'; title?: string; items: CommandCardListItem[] })
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
       * that owns the tail draws the view into the card's body. There is one card per panel:
       * running its command again moves the card to the end.
       */
      kind: 'panel'
      panel: string
      title?: string
    })

export type ChatTailConfirmCard = Extract<ChatTailCard, { kind: 'confirm' }>

/** A card as the page creates it; the tail's owner adds the id and the scope. */
export type ChatTailCardDraft<Target = unknown> =
  ChatTailCard<Target> extends infer Card
    ? Card extends TailCardBase
      ? Omit<Card, 'id' | 'scope'>
      : never
    : never

/** The body of a panel card: an empty box that the owner of the tail fills. */
const PanelCardBody: React.FC<{
  panel: string
  onHost: (panel: string, element: HTMLElement | null) => void
}> = ({ panel, onHost }) => {
  const setHost = React.useCallback(
    (element: HTMLDivElement | null) => onHost(panel, element),
    [panel, onHost]
  )
  return <CommandCardPanelBody ref={setHost} />
}

/** The rows that follow the last message of the Agent column: one card per command, in order. */
export function ChatCommandTail<Target>({
  cards,
  onLink,
  onAnswer,
  onPanelHost
}: {
  cards: readonly ChatTailCard<Target>[]
  onLink: (target: Target) => void
  /** The person chose the default button (`confirmed`) or cancel on a confirm card. */
  onAnswer: (card: ChatTailConfirmCard, confirmed: boolean) => void
  /** The body element of a panel card, or null when the card left. */
  onPanelHost: (panel: string, element: HTMLElement | null) => void
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
              <PanelCardBody panel={card.panel} onHost={onPanelHost} />
            </ChatCommandResultCard>
          )
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
              <CommandCardList items={card.items} />
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
