export type Agency =
  | 'human_authored_or_unclear'
  | 'human_driven_agent_assisted'
  | 'fully_autonomous'
  | 'agent_or_bot_unclear'

export interface Actor {
  login: string
  type: 'User' | 'Bot' | 'Unknown'
}

export interface ReviewSignal {
  author: Actor
  state: string
  bodyLength: number
  inlineComments: number
  inlineCommentLength: number
  submittedAt: string | null
}

export interface PullRequestRecord {
  number: number
  title: string
  url: string
  createdAt: string
  mergedAt: string
  author: Actor
  attributedHuman: string | null
  agency: Agency
  agents: string[]
  labels: string[]
  assignees: string[]
  scope: string | null
  comments: number
  reactions: number
  automated: boolean
  linkedIssues: number[]
  bodySignals: string[]
  evidence: string[]
  reverted: boolean
  reviewsEnriched: boolean
  reviews: ReviewSignal[]
}

export interface MonthShard {
  month: string
  from: string
  to: string
  prs: PullRequestRecord[]
}

export interface DataManifest {
  generatedAt: string | null
  sourceRepo: string
  availableMonths: string[]
  minDate: string | null
  maxDate: string | null
  prCount: number
  reviewEnrichedPrs?: number
  methodologyVersion?: string
}

export interface ScoreBreakdown {
  outcome: number
  reach: number
  durability: number
  engineeringLeverage: number
  baseImpact: number
  total: number
  reasons: string[]
}

export interface RankedEngineer {
  login: string
  kind: 'human' | 'agent-or-bot'
  score: number
  authoredImpact: number
  collaborationLeverage: number
  prCount: number
  reviewCount: number
  agentAssistedImpactShare: number
  topContributions: Array<{ pr: PullRequestRecord; score: ScoreBreakdown }>
}
