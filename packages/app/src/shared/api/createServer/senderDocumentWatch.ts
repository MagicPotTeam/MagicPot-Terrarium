// packages/app/src/shared/api/createServer/senderDocumentWatch.ts
// One set of listeners per WebContents for everything in the main process that must end with the
// sender's document: open IPC streams (registerIpcServer.ts), pending canvas path reads
// (main/api/canvasPathReadApproval.ts) and Agent thread interaction leases
// (main/api/agentThreadInteractions.ts). Each stream and each read used to add its own three
// listeners ('did-start-navigation', 'render-process-gone', 'destroyed'), so the listener count of
// the main window's WebContents grew with every running request and no fixed limit could be right
// for it (the leases already shared a dispatcher of their own, which this one replaces). Now the
// count is three (one of each event) however many watchers there are, and none once the last
// watcher has stopped.
//
// Every watcher gets the events it got as a listener of its own, with the navigation event's own
// arguments, so each keeps its own rule for which navigation ends it. The watchers of one event run
// in the order they subscribed, all together at the place of the first one's listener; nothing
// depends on their order relative to other listeners, because every watcher only aborts its work.

/** The arguments of 'did-start-navigation' a watcher may look at (new and legacy form). */
export type DocumentNavigationArgs = [
  details: { isMainFrame?: boolean; isSameDocument?: boolean } | undefined,
  url?: string,
  isInPlace?: boolean,
  isMainFrame?: boolean
]

export type SenderDocumentWatcher = {
  /** 'did-start-navigation' of any frame, same-document ones included: the watcher filters. */
  navigation?: (...args: DocumentNavigationArgs) => void
  /** 'render-process-gone'. */
  gone?: () => void
  /** 'destroyed'. */
  destroyed?: () => void
}

type EventSender = {
  on(event: string, listener: (...args: never[]) => void): unknown
  removeListener(event: string, listener: (...args: never[]) => void): unknown
}
type Watch = { watchers: Set<SenderDocumentWatcher>; detach(): void }

const watches = new WeakMap<object, Watch>()

const isEventSender = (sender: unknown): sender is EventSender =>
  !!sender &&
  typeof sender === 'object' &&
  typeof (sender as Partial<EventSender>).on === 'function' &&
  typeof (sender as Partial<EventSender>).removeListener === 'function'

/**
 * Calls every watcher that is subscribed when the event arrives. A watcher added during the event
 * is not called for it; one stopped during the event (by itself or by another watcher) is not
 * called any more. One watcher's failure does not keep the others from being called: all of them
 * run, then the first failure is thrown on, as a listener of its own would have thrown it.
 */
function dispatch(
  watchers: Set<SenderDocumentWatcher>,
  call: (watcher: SenderDocumentWatcher) => void
): void {
  let failed = false
  let failure: unknown
  for (const watcher of [...watchers]) {
    if (!watchers.has(watcher)) continue
    try {
      call(watcher)
    } catch (error) {
      if (!failed) {
        failed = true
        failure = error
      }
    }
  }
  if (failed) throw failure
}

/**
 * Subscribes `watcher` to the document events of `sender`; returns the function that stops it
 * (safe to call more than once). The order in which watchers are stopped does not matter.
 *
 * A sender that cannot be listened to (none, or a stub without on / removeListener) is refused with
 * a TypeError, as calling its own `on` used to fail: work that must end with the document (a path
 * read, an interaction lease) then never starts unwatched. Only with `optional` (IPC streams, whose
 * listeners were always best-effort) is such a sender simply not watched.
 */
export function watchSenderDocument(
  sender: unknown,
  watcher: SenderDocumentWatcher,
  options: { optional?: boolean } = {}
): () => void {
  if (!isEventSender(sender)) {
    if (options.optional) return () => undefined
    throw new TypeError('The sender document cannot be watched.')
  }
  let watch = watches.get(sender)
  if (!watch) {
    const watchers = new Set<SenderDocumentWatcher>()
    const onNavigation = (...args: DocumentNavigationArgs): void =>
      dispatch(watchers, (each) => each.navigation?.(...args))
    const onGone = (): void => dispatch(watchers, (each) => each.gone?.())
    const onDestroyed = (): void => dispatch(watchers, (each) => each.destroyed?.())
    const created: Watch = {
      watchers,
      detach: () => {
        sender.removeListener('did-start-navigation', onNavigation)
        sender.removeListener('render-process-gone', onGone)
        sender.removeListener('destroyed', onDestroyed)
        if (watches.get(sender) === created) watches.delete(sender)
      }
    }
    sender.on('did-start-navigation', onNavigation)
    sender.on('render-process-gone', onGone)
    sender.on('destroyed', onDestroyed)
    watches.set(sender, created)
    watch = created
  }
  const own = watch
  // A private copy: the same watcher object subscribed twice is two subscriptions.
  const entry: SenderDocumentWatcher = { ...watcher }
  own.watchers.add(entry)
  return () => {
    if (!own.watchers.delete(entry)) return
    // The last watcher of this sender is gone: no listener stays behind.
    if (own.watchers.size === 0) own.detach()
  }
}
