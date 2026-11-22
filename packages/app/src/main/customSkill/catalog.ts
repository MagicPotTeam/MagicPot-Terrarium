import type { Config } from '@shared/config/config'
import { THREAD_SKILL_LIMITS as LIMITS, type ThreadProceduralSkill } from '@shared/api/agentThreadSkill'
import { CustomSkillFSCli } from './fs'
import { loadRegisteredSkillPackages } from './packages'

/** JSON remains available; registrations add inert Markdown, never grant tools. */
export async function loadUserProceduralCatalog(config: Config, projectId: string, signal?: AbortSignal) {
  const json = await new CustomSkillFSCli(config).listProceduralSkills(signal)
  signal?.throwIfAborted()
  const markdown = await loadRegisteredSkillPackages(config.llm_config.proceduralSkillPackages ?? [], projectId, signal)
  const all = [...json.skills, ...markdown.skills], skills: ThreadProceduralSkill[] = []
  let bytes = 0, truncated = json.truncated || markdown.truncated
  for (const skill of all.sort((a, b) => a.id.localeCompare(b.id))) {
    // Fail closed on collisions, including JSON/package names. Do not silently
    // override user intent using filesystem enumeration or package registration order.
    if (all.some(other => other !== skill && (other.id === skill.id || other.name === skill.name || other.id === skill.name || other.name === skill.id))) { truncated = true; continue }
    const size = Buffer.byteLength(JSON.stringify(skill))
    if (skills.length >= LIMITS.files || bytes + size > LIMITS.totalBytes) { truncated = true; continue }
    bytes += size; skills.push(skill)
  }
  return { skills, truncated }
}
