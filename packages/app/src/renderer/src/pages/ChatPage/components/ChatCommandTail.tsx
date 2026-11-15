import React from 'react'
import {
  ChatCommandResultCard,
  CommandCardActions,
  CommandCardList,
  CommandCardNote,
  CommandCardText,
  type CommandCardListItem
} from './ChatCommandCard'

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

/** A card as the page creates it; the tail's owner adds the id and the scope. */
export type ChatTailCardDraft<Target = unknown> =
  ChatTailCard<Target> extends infer Card
    ? Card extends TailCardBase
      ? Omit<Card, 'id' | 'scope'>
      : never
    : never

/** The rows that follow the last message of the Agent column: one card per command, in order. */
export function ChatCommandTail<Target>({
  cards,
  onLink
}: {
  cards: readonly ChatTailCard<Target>[]
  onLink: (target: Target) => void
}): React.ReactElement {
  return (
    <>
      {cards.map((card) => {
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
