import type { PullRequestRecord, RankedEngineer, ScoreBreakdown } from './types'

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const has = (value: string, pattern: RegExp) => pattern.test(value.toLowerCase())
const fileHas = (pr: PullRequestRecord, pattern: RegExp) => pr.files.some((file) => pattern.test(file.path))

export function scorePullRequest(pr: PullRequestRecord): ScoreBreakdown {
  const text = `${pr.title} ${pr.labels.join(' ')} ${pr.bodySignals.join(' ')}`.toLowerCase()
  const reasons: string[] = []

  let outcome = 2
  if (has(text, /security|permission|auth|data loss|incident|reliab|corrupt|vulnerab/)) {
    outcome = 5
    reasons.push('High-stakes security/reliability outcome')
  } else if (has(text, /feat|launch|new product|new api|new endpoint|ship|enable/)) {
    outcome = 4
    reasons.push('Ships a user/product capability')
  } else if (has(text, /fix|bug|regression|correct|repair/)) {
    outcome = 3.5
    reasons.push('Fixes incorrect behavior')
  } else if (has(text, /refactor|simplif|cleanup|chore/)) {
    outcome = 2.5
    reasons.push('Improves the engineering system')
  }
  if (pr.closingIssues.length > 0) {
    outcome = clamp(outcome + 0.4, 1, 5)
    reasons.push(`Closes ${pr.closingIssues.length} linked issue${pr.closingIssues.length === 1 ? '' : 's'}`)
  }

  const roots = new Set(pr.files.map((f) => f.path.split('/')[0]).filter(Boolean))
  let reach = 1.5
  if (roots.size >= 3) reach += 0.75
  if (fileHas(pr, /^(posthog|ee|common|rust|services|tools)\//)) {
    reach += 1.1
    reasons.push('Touches shared/core platform code')
  }
  if (fileHas(pr, /migrations?|schema|openapi|api\/|routes?|frontend\/generated/i)) {
    reach += 0.7
    reasons.push('Changes an API/schema/data contract')
  }
  if (fileHas(pr, /\.github\/|terraform|helm|charts|docker|dagster|temporal|ci\//i)) {
    reach += 0.75
    reasons.push('Affects delivery or platform infrastructure')
  }
  const frontend = fileHas(pr, /frontend\//i)
  const backend = fileHas(pr, /backend\/|posthog\/|ee\//i)
  if (frontend && backend) reach += 0.45
  reach = clamp(reach, 1, 5)

  let durability = 1.5
  if (fileHas(pr, /test|spec\.|__tests__|tests\//i)) {
    durability += 1.25
    reasons.push('Adds or updates automated tests')
  }
  if (fileHas(pr, /migration/i)) {
    durability += 0.7
    reasons.push('Carries explicit migration work')
  }
  if (fileHas(pr, /README|ARCHITECTURE|AGENTS\.md|docs\//i)) {
    durability += 0.55
    reasons.push('Leaves durable docs/architecture context')
  }
  if (has(text, /idempot|backward|rollback|fail.closed|guard|dedup|rate limit|observab|hardening|safety/)) {
    durability += 0.85
    reasons.push('Includes rollout/safety/operability evidence')
  }
  durability = clamp(durability, 1, 5)

  let engineeringLeverage = 0
  if (fileHas(pr, /^tools\/|\.github\/|hogli|owners|codeowners|ci\//i) || has(text, /devex|developer experience|tooling|automation/)) {
    engineeringLeverage += 8
    reasons.push('Improves developer/tooling leverage')
  }
  if (fileHas(pr, /^(posthog|common|services)\//) && roots.size >= 2) engineeringLeverage += 5
  if (has(text, /mcp|agent|scout|reviewhog|codex|claude|automation/)) {
    engineeringLeverage += 5
    reasons.push('Builds reusable automation/agent leverage')
  }
  if (has(text, /refactor|simplif|single source|shared|reusable|resolver|primitive/)) {
    engineeringLeverage += 4
    reasons.push('Reduces future implementation cost')
  }
  if (fileHas(pr, /owners\.yaml|CODEOWNERS|ARCHITECTURE|AGENTS\.md/i)) engineeringLeverage += 3
  engineeringLeverage = clamp(engineeringLeverage, 0, 25)

  const baseImpact = outcome * reach * durability
  const total = baseImpact + engineeringLeverage
  return {
    outcome: round(outcome),
    reach: round(reach),
    durability: round(durability),
    engineeringLeverage: round(engineeringLeverage),
    baseImpact: round(baseImpact),
    total: round(total),
    reasons: reasons.slice(0, 5),
  }
}

function reviewLeverage(pr: PullRequestRecord, reviewer: string): number {
  const reviews = pr.reviews.filter((review) => review.author.login === reviewer)
  if (!reviews.length) return 0
  const target = scorePullRequest(pr)
  let value = 0
  for (const review of reviews) {
    const state = review.state.toUpperCase()
    let v = state === 'CHANGES_REQUESTED' ? 4.5 : state === 'APPROVED' ? 3 : 1.5
    if (review.bodyLength >= 120) v += 1.5
    if (review.threadComments > 0) v += Math.min(2, review.threadComments * 0.5)
    value += v
  }
  return value * (0.8 + Math.min(0.5, target.total / 220))
}

function diminishing(values: number[]): number {
  return values
    .sort((a, b) => b - a)
    .reduce((sum, value, index) => sum + value / Math.sqrt(index + 1), 0)
}

function creditLogin(pr: PullRequestRecord): string {
  if (pr.agency === 'human_driven_agent_assisted' && pr.attributedHuman) return pr.attributedHuman
  return pr.author.login
}

export function rankEngineers(prs: PullRequestRecord[]): RankedEngineer[] {
  const authored = new Map<string, Array<{ pr: PullRequestRecord; score: ScoreBreakdown }>>()
  const reviews = new Map<string, Array<{ value: number; pr: PullRequestRecord }>>()
  const kinds = new Map<string, 'human' | 'agent-or-bot'>()

  for (const pr of prs) {
    const login = creditLogin(pr)
    const score = scorePullRequest(pr)
    const items = authored.get(login) ?? []
    items.push({ pr, score })
    authored.set(login, items)
    kinds.set(login, pr.author.type === 'Bot' || pr.agency === 'fully_autonomous' ? 'agent-or-bot' : 'human')

    const reviewers = new Set(pr.reviews.map((review) => review.author.login).filter(Boolean))
    for (const reviewer of reviewers) {
      if (reviewer === login) continue
      const value = reviewLeverage(pr, reviewer)
      if (!value) continue
      const reviewItems = reviews.get(reviewer) ?? []
      reviewItems.push({ value, pr })
      reviews.set(reviewer, reviewItems)
      if (!kinds.has(reviewer)) kinds.set(reviewer, 'human')
    }
  }

  const logins = new Set([...authored.keys(), ...reviews.keys()])
  return [...logins]
    .map((login) => {
      const contributions = (authored.get(login) ?? []).sort((a, b) => b.score.total - a.score.total)
      const authoredImpact = diminishing(contributions.map((item) => item.score.total))
      const reviewItems = reviews.get(login) ?? []
      const collaborationLeverage = Math.min(45, diminishing(reviewItems.map((item) => item.value)))
      const totalRaw = authoredImpact + collaborationLeverage
      const assistedRaw = contributions
        .filter((item) => item.pr.agency === 'human_driven_agent_assisted')
        .reduce((sum, item) => sum + item.score.total, 0)
      const allRaw = contributions.reduce((sum, item) => sum + item.score.total, 0)
      return {
        login,
        kind: kinds.get(login) ?? 'human',
        score: round(totalRaw),
        authoredImpact: round(authoredImpact),
        collaborationLeverage: round(collaborationLeverage),
        prCount: contributions.length,
        reviewCount: reviewItems.length,
        agentAssistedImpactShare: allRaw ? round((assistedRaw / allRaw) * 100) : 0,
        topContributions: contributions.slice(0, 4),
      }
    })
    .filter((engineer) => engineer.prCount > 0 || engineer.collaborationLeverage >= 4)
    .sort((a, b) => b.score - a.score)
}

const round = (value: number) => Math.round(value * 10) / 10
