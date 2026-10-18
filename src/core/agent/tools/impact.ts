import { analyseImpact, impactText } from '../../impact/impact'
import type { ReviewFile } from '@shared/types'
import { type AgentTool } from './types'

/** Where the changes to check come from: the session's latest request (main supplies it). */
export interface ImpactHost {
  latest(sessionId: string): Promise<ReviewFile[]>
}

export function createImpactTool(host: ImpactHost): AgentTool {
  return {
    spec: {
      name: 'check_impact',
      description:
        'Before you finish a change to code, check what it could break: which functions, classes and values you changed, every place in the project that uses them, the files that import what you changed, and the test files that reach it (with the command to run only those). Read the uses it lists and fix any you broke; then run the affected tests.',
      parameters: { type: 'object', properties: {} }
    },
    primaryArg: null,
    readOnly: true,
    risk: () => null,
    summary: () => 'check what the changes could break',
    async execute(_args, ctx) {
      const files = await host.latest(ctx.sessionId)
      if (!files.length) return { content: 'You have not changed any files in this request yet.', isError: false }
      const r = await analyseImpact(ctx.workspace, files)
      return { content: impactText(r), isError: false, meta: { impact: r } }
    }
  }
}
