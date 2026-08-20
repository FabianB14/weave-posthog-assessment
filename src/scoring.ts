import type { PullRequestRecord, RankedEngineer, ScoreBreakdown } from './types'

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const signal = (pr: PullRequestRecord, value: string) => pr.bodySignals.includes(value)
const anySignal = (pr: PullRequestRecord, values: string[]) => values.some((value) => signal(pr, value))
const round = (value: number) => Math.round(value * 10) / 10

export function scorePullRequest(pr: PullRequestRecord): ScoreBreakdown {
  const reasons: string[] = []
  const lowerTitle = pr.title.toLowerCase()

  let outcome = 2
  if (pr.automated) {
    outcome = 1
    reasons.push('Automated maintenance: counted, but not treated as engineering outcome by itself')
  } else if (anySignal(pr, ['security', 'reliability', 'data_integrity'])) {
    outcome = 5
    reasons.push('High-stakes security/reliability/data-integrity outcome')
  } else if (anySignal(pr, ['new_capability', 'new_product', 'public_surface']) || lowerTitle.startsWith('feat')) {
    outcome = 4.2
    reasons.push('Ships a product or platform capability')
  } else if (signal(pr, 'bug_fix') || lowerTitle.startsWith('fix')) {
    outcome = 3.5
    reasons.push('Fixes incorrect user or system behavior')
  } else if (signal(pr, 'refactor') || lowerTitle.startsWith('refactor')) {
    outcome = 2.8
    reasons.push('Improves system structure without claiming feature impact')
  }
  if (pr.linkedIssues.length > 0) {
    outcome = clamp(outcome + 0.3, 1, 5)
    reasons.push(`Explicitly closes/fixes ${pr.linkedIssues.length} issue${pr.linkedIssues.length === 1 ? '' : 's'}`)
  }

  let reach = 1.5
  if (signal(pr, 'cross_product')) {
    reach += 1.4
    reasons.push('Explicit cross-product or fleet-wide reach')
  }
  if (signal(pr, 'shared_primitive')) {
    reach += 1.1
    reasons.push('Creates/changes a shared primitive')
  }
  if (signal(pr, 'public_surface')) {
    reach += 0.9
    reasons.push('Changes a public/API/schema surface')
  }
  if (signal(pr, 'devex')) {
    reach += 0.8
    reasons.push('Developer-system impact can reach many engineers')
  }
  if (signal(pr, 'migration')) reach += 0.45
  if (signal(pr, 'user_facing')) reach += 0.35
  reach = clamp(reach, 1, 5)

  let durability = 1.4
  if (signal(pr, 'automated_tests')) {
    durability += 0.9
    reasons.push('Automated verification evidence')
  }
  if (signal(pr, 'e2e_or_live_test')) {
    durability += 0.75
    reasons.push('End-to-end/live/manual verification evidence')
  }
  if (signal(pr, 'docs_or_architecture')) durability += 0.45
  if (signal(pr, 'migration')) durability += 0.45
  if (anySignal(pr, ['rollout_safety', 'idempotency', 'backward_compat'])) {
    durability += 0.7
    reasons.push('Rollout/backward-compatibility/idempotency safeguards')
  }
  if (signal(pr, 'observability')) durability += 0.35
  if (signal(pr, 'not_tested')) {
    durability -= 0.9
    reasons.push('Explicitly notes an untested surface')
  }
  if (pr.reverted) {
    durability -= 2.2
    reasons.push('Reverted within the analyzed window')
  }
  durability = clamp(durability, 1, 5)

  let engineeringLeverage = 0
  if (signal(pr, 'shared_primitive')) engineeringLeverage += 8
  if (signal(pr, 'devex')) engineeringLeverage += 8
  // Agent/tool attribution is deliberately score-neutral. A contribution earns leverage
  // only through the engineering outcome it creates, never because an agent was used.
  if (signal(pr, 'cross_product')) engineeringLeverage += 5
  if (signal(pr, 'ownership')) engineeringLeverage += 4
  if (signal(pr, 'refactor')) engineeringLeverage += 4
  if (anySignal(pr, ['backward_compat', 'idempotency'])) engineeringLeverage += 2
  if (pr.automated) engineeringLeverage = Math.min(engineeringLeverage, 2)
  engineeringLeverage = clamp(engineeringLeverage, 0, 25)

  const baseImpact = outcome * reach * durability
  return {
    outcome: round(outcome),
    reach: round(reach),
    durability: round(durability),
    engineeringLeverage: round(engineeringLeverage),
    baseImpact: round(baseImpact),
    total: round(baseImpact + engineeringLeverage),
    reasons: reasons.slice(0, 5),
  }
}

function reviewLeverage(pr: PullRequestRecord, reviewer: string): number {
  const review = pr.reviews.find((item) => item.author.login === reviewer)
  if (!review) return 0
  const state = review.state.toUpperCase()
  let value = state === 'CHANGES_REQUESTED' ? 4.5 : state === 'APPROVED' ? 3 : 1.5
  if (review.bodyLength + review.inlineCommentLength >= 160) value += 1.5
  if (review.inlineComments > 0) value += Math.min(2.5, review.inlineComments * 0.5)
  const targetImpact = scorePullRequest(pr).total
  return value * (0.75 + Math.min(0.65, targetImpact / 150))
}

function diminishing(values: number[]): number {
  return [...values]
    .sort((a, b) => b - a)
    .reduce((sum, value, index) => sum + value / Math.sqrt(index + 1), 0)
}

function creditLogin(pr: PullRequestRecord): string {
  if (pr.agency === 'human_driven_agent_assisted' && pr.attributedHuman) return pr.attributedHuman
  return pr.author.login
}

function creditKind(pr: PullRequestRecord): 'human' | 'agent-or-bot' {
  // If a PR explicitly says a human drove the work, credit the DRI as a human even when
  // the GitHub author itself is a bot/agent account. Agent usage is reported separately.
  if (pr.agency === 'human_driven_agent_assisted' && pr.attributedHuman) return 'human'
  return pr.author.type === 'Bot' || pr.agency === 'fully_autonomous' || pr.agency === 'agent_or_bot_unclear'
    ? 'agent-or-bot'
    : 'human'
}

export function rankEngineers(prs: PullRequestRecord[]): RankedEngineer[] {
  const authored = new Map<string, Array<{ pr: PullRequestRecord; score: ScoreBreakdown }>>()
  const reviews = new Map<string, number[]>()
  const kinds = new Map<string, 'human' | 'agent-or-bot'>()

  for (const pr of prs) {
    const login = creditLogin(pr)
    const score = scorePullRequest(pr)
    const contributions = authored.get(login) ?? []
    contributions.push({ pr, score })
    authored.set(login, contributions)
    kinds.set(login, creditKind(pr))

    if (pr.reviewsEnriched) {
      for (const review of pr.reviews) {
        const reviewer = review.author.login
        if (!reviewer || reviewer === login || review.author.type === 'Bot') continue
        const value = reviewLeverage(pr, reviewer)
        if (!value) continue
        const values = reviews.get(reviewer) ?? []
        values.push(value)
        reviews.set(reviewer, values)
        if (!kinds.has(reviewer)) kinds.set(reviewer, 'human')
      }
    }
  }

  const logins = new Set([...authored.keys(), ...reviews.keys()])
  return [...logins]
    .map((login) => {
      const contributions = (authored.get(login) ?? []).sort((a, b) => b.score.total - a.score.total)
      const authoredImpact = diminishing(contributions.map((item) => item.score.total))
      const reviewValues = reviews.get(login) ?? []
      const collaborationLeverage = Math.min(45, diminishing(reviewValues))
      const rawTotal = contributions.reduce((sum, item) => sum + item.score.total, 0)
      const assisted = contributions.filter((item) => item.pr.agency === 'human_driven_agent_assisted').reduce((sum, item) => sum + item.score.total, 0)
      return {
        login,
        kind: kinds.get(login) ?? 'human',
        score: round(authoredImpact + collaborationLeverage),
        authoredImpact: round(authoredImpact),
        collaborationLeverage: round(collaborationLeverage),
        prCount: contributions.length,
        reviewCount: reviewValues.length,
        agentAssistedImpactShare: rawTotal ? round((assisted / rawTotal) * 100) : 0,
        topContributions: contributions.slice(0, 4),
      }
    })
    .filter((engineer) => engineer.prCount > 0 || engineer.collaborationLeverage >= 4)
    .sort((a, b) => b.score - a.score)
}
