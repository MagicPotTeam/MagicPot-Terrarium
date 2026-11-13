import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import { dispatchCanvasTargetMediaAttachmentToCanvas } from '../../ProjectCanvasPage/canvasTargetMediaDispatch'
import type { ChatSession } from '../chatStorage'

type ImageCandidate = { memberId: string; attachment: ChatAttachment; slot: string; label: string }

function images(members: ChatSession[]): ImageCandidate[] {
  return members.flatMap((member) => {
    let index = 0
    return member.messages.flatMap((message, messageIndex) =>
      message.role === 'assistant'
        ? (message.attachments ?? []).filter((attachment) => attachment.type === 'image').map((attachment, attachmentIndex) => {
          index += 1
          const name = Array.from(member.teamMemberName || '成员', ch => {
            const code = ch.codePointAt(0)!
            return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? ' ' : ch
          }).join('').trim() || '成员'
          const label = `${Array.from(name).slice(0, 48).join('')}·图${index}`
          return { memberId: member.id, slot: JSON.stringify([member.id, messageIndex, attachmentIndex]), label, attachment: { ...attachment, fileName: `${member.teamMemberName}·图${index}` } }
        }).filter(({ attachment }) => attachment.url?.trim())
        : []
    )
  })
}

function key(memberId: string, attachment: ChatAttachment): string {
  return JSON.stringify([memberId, attachment.url])
}

function isAutoSaveRewrite(previous: ChatAttachment, next: ChatAttachment): boolean {
  if (/^file:\/\//i.test(previous.url) || !/^file:\/\//i.test(next.url)) return false
  const { url: _oldUrl, ...oldFields } = previous
  const { url: _newUrl, ...newFields } = next
  return JSON.stringify(oldFields) === JSON.stringify(newFields)
}

// Existing history is a baseline, not a queue: reopening a team must not replay it.
export function useTeamImagePlacement(projectId: string, members: ChatSession[], observerKey?: string) {
  const state = useRef<{ projectId: string; observerKey?: string; seen: Set<string>; slots: Map<string,ChatAttachment>; aliases: Map<string,string>; knownMembers: Set<string>; registered: Set<string>; placed: Set<string>; pending: Set<string>; active: boolean; placeActive: boolean } | null>(null)
  if (!state.current || state.current.projectId !== projectId || state.current.observerKey !== observerKey) {
    const baseline = images(members)
    state.current = { projectId, observerKey, seen: new Set(baseline.map(({ memberId, attachment }) => key(memberId, attachment))), slots: new Map(baseline.map(item => [item.slot, item.attachment])), aliases: new Map(baseline.map(item => [key(item.memberId, item.attachment), key(item.memberId, item.attachment)] as const)), knownMembers: new Set(members.map((member) => member.id)), registered: new Set(), placed: new Set(), pending: new Set(), active: false, placeActive: false }
  }
  const current = state.current
  const place = (memberId: string, attachment: ChatAttachment, slot?: string, label?: string, candidateSlot?: string) => {
    if (state.current !== current || !current.placeActive) return
    const imageKey = slot ?? current.aliases.get(key(memberId, attachment)) ?? key(memberId, attachment)
    if (!attachment.url?.trim() || current.pending.has(imageKey) || current.placed.has(imageKey)) return
    current.pending.add(imageKey)
    const candidates = label ? [] : images(members).filter(item => item.memberId === memberId && item.attachment.url === attachment.url)
    const teamImageLabel = label ?? (candidateSlot ? candidates.find(item => item.slot === candidateSlot)?.label : candidates.length === 1 ? candidates[0].label : undefined)
    void dispatchCanvasTargetMediaAttachmentToCanvas(attachment, projectId, memberId, teamImageLabel ? { teamImageLabel } : undefined).then((result) => {
      if (result.dispatched) current.placed.add(imageKey)
    }).catch(() => { /* Allow a manual retry if placement failed. */ }).finally(() => current.pending.delete(imageKey))
  }
  // Only a confirmed, empty creation committed before the member is published is a boundary.
  const registerEmptyMember = (memberId: string) => {
    if (state.current === current && current.active && memberId && !current.knownMembers.has(memberId)) current.registered.add(memberId)
  }
  useLayoutEffect(() => {
    current.placeActive = true
    return () => { current.placeActive = false }
  }, [current])
  useEffect(() => {
    current.active = true
    return () => { current.active = false }
  }, [current])
  useEffect(() => {
    const newMembers = new Set(members.filter((member) => !current.knownMembers.has(member.id)).map((member) => member.id))
    for (const { memberId, attachment, slot, label } of images(members)) {
      const imageKey = key(memberId, attachment)
      const previous = current.slots.get(slot)
      current.slots.set(slot, attachment)
      const rewrite = previous && (previous.url === attachment.url || isAutoSaveRewrite(previous, attachment))
      if (rewrite) {
        current.aliases.set(imageKey, current.aliases.get(key(memberId, previous)) ?? slot)
        current.seen.add(imageKey)
        continue
      }
      if (!current.aliases.has(imageKey)) current.aliases.set(imageKey, imageKey)
      if (current.seen.has(imageKey)) continue
      current.seen.add(imageKey)
      if (!newMembers.has(memberId) || current.registered.has(memberId)) place(memberId, attachment, imageKey, label)
    }
    members.forEach((member) => { current.knownMembers.add(member.id); current.registered.delete(member.id) })
  }, [members, current])
  return { place, registerEmptyMember }
}
