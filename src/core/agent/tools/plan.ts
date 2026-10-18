import { str, type AgentTool } from './types'

/** Only offered in plan mode: hand the plan to the user and wait for approve, feedback, or discard. */
export const presentPlanTool: AgentTool = {
  spec: {
    name: 'present_plan',
    description:
      'Plan mode. Present your complete plan for approval once you have read enough to be sure of it. The user can edit it, approve it (the work then starts as the next turn), or send it back with feedback (revise and present it again). ' +
      'Write self-contained markdown: the goal, what you found, the files to touch, numbered steps, how the result will be checked, and anything risky or undecided.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short name for the plan' },
        plan: { type: 'string', description: 'The plan in markdown' }
      },
      required: ['title', 'plan']
    }
  },
  primaryArg: null,
  readOnly: false,
  risk: () => null,
  summary: (a) => `plan: ${str(a, 'title') || 'untitled'}`,
  async execute(args, ctx) {
    const title = str(args, 'title').trim() || 'Plan'
    const plan = str(args, 'plan').trim()
    if (plan.length < 40) return { content: 'The plan is too short to approve. Investigate first, then present real steps.', isError: true }
    const d = await ctx.presentPlan({ title, plan })
    if (ctx.signal.aborted) return { content: 'Stopped before the plan was answered.', isError: false, meta: { endTurn: true } }
    if (d.action === 'revise') {
      return { content: `The user wants the plan changed before any work starts:\n\n${d.feedback || '(no details given)'}\n\nRevise the plan and call present_plan again.`, isError: false }
    }
    if (d.action === 'discard') {
      return { content: 'The user discarded the plan. Nothing will be carried out. Stop here.', isError: false, meta: { endTurn: true } }
    }
    // keep the approved text with the project: it is what the next turn is held to
    let saved = ''
    try {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'plan'
      saved = `.prism/plans/${new Date().toISOString().slice(0, 10)}-${slug}.md`
      await ctx.workspace.write(saved, `# ${title}\n\n${d.plan.trim()}\n`)
    } catch {
      saved = ''
    }
    return {
      content: `The user approved the plan${d.plan.trim() !== plan ? ' after editing it' : ''}. Stop here: the work starts in the next turn, with the approved plan as its instruction.`,
      isError: false,
      meta: { endTurn: true, plan: d.plan, ...(saved ? { planFile: saved } : {}) }
    }
  }
}
