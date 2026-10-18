import type { Skill } from '../../skills/skills'
import { err, str, type AgentTool } from './types'

/** How use_skill reaches the session's skills (the engine and the Claude runner each provide one). */
export interface SkillHost {
  all(): Skill[]
  /** Mark the skill as in use for the rest of the session. */
  use(skill: Skill): void
}

export function createUseSkillTool(host: SkillHost): AgentTool {
  return {
    spec: {
      name: 'use_skill',
      description: "Load one of this project's skills: written instructions for a particular kind of work. The ones available are listed in your instructions under \"Other skills\". Load a skill before starting work it covers, then follow it.",
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'The skill\'s name, as listed' } }, required: ['name'] }
    },
    primaryArg: 'name',
    readOnly: true,
    risk: () => null,
    summary: (a) => `use skill ${str(a, 'name')}`,
    async execute(args) {
      const name = str(args, 'name').trim().toLowerCase()
      const skill = host.all().find((s) => s.name === name)
      if (!skill) return err(`There is no skill named "${name}". Available: ${host.all().map((s) => s.name).join(', ') || 'none'}.`)
      host.use(skill)
      return { content: `# ${skill.name}\n${skill.body}`, isError: false, meta: { skill: skill.name } }
    }
  }
}
