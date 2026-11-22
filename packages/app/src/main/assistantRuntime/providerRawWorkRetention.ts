import { isPromise, isProxy } from 'node:util/types'
import { ProviderRawWorkOwnershipError, sinkUnsupportedProviderRejection, type ProviderRawWorkRetainer } from '@shared/llm/providerRawWork'
import type { CooperativeOperationGate } from '../magicAgentPlatform2/agents/cooperativeExecutionController'

const promisePrototype = Promise.prototype
const promiseThen = Promise.prototype.then
const ordinary = (value: unknown): value is Promise<void> =>
  isPromise(value) && !isProxy(value) && Object.getPrototypeOf(value) === promisePrototype &&
  !Object.getOwnPropertyDescriptor(value, 'constructor') && !Object.getOwnPropertyDescriptor(value, 'then')

/** Exact chat child only; passive drain never exposes its own descendant gate. */
export const createProviderRawWorkRetainer = (
  chatChild: CooperativeOperationGate | undefined,
  signal: AbortSignal | undefined,
  assertCurrent: () => void
): ProviderRawWorkRetainer => (drain, admitted) => {
  if (!chatChild || !ordinary(drain)) throw new ProviderRawWorkOwnershipError('exact chat child and local drain required.')
  signal?.throwIfAborted()
  assertCurrent()
  let entered = false
  const held = chatChild.run('llm-inference', signal, () => {
    signal?.throwIfAborted()
    assertCurrent()
    entered = true
    admitted()
    return drain
  })
  if (!ordinary(held)) {
    // Defensive invalid gate, not the concrete controller's normal return. Only
    // genuinely branded non-Proxy promises reach the bounded rejection sink.
    if (isPromise(held) && !isProxy(held)) sinkUnsupportedProviderRejection(held)
    throw new ProviderRawWorkOwnershipError('exact gate did not return its ordinary native promise.')
  }
  // Observe immediately, never await this passive child before work/disposal.
  Reflect.apply(promiseThen, held, [() => undefined, () => undefined])
  if (!entered) throw new ProviderRawWorkOwnershipError('exact child admission was not synchronous.')
}
