/**
 * "/goal" opens the goal records of the current thread. The records are created and changed in
 * that view, so any text typed after the name is accepted and ignored.
 */
export function isAgentGoalCommand(text: string): boolean {
  return /^\/goal(?:\s|$)/i.test(text.trimStart())
}
