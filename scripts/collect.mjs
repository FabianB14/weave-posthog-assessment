import fs from 'node:fs/promises'
import path from 'node:path'

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!TOKEN) throw new Error('Set GH_TOKEN (a GitHub token with public_repo/read access)')

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (!value.startsWith('--')) return pairs
  pairs.push([value.slice(2), all[index + 1]])
  return pairs
}, []))
const from = args.from
const to = args.to
if (!from || !to) throw new Error('Usage: npm run collect -- --from YYYY-MM-DD --to YYYY-MM-DD')
if (new Date(from) > new Date(to)) throw new Error('--from must be <= --to')

const REPO = 'PostHog/posthog'
const OUTPUT = path.resolve('public/data')
const MONTHS = path.join(OUTPUT, 'months')
await fs.mkdir(MONTHS, { recursive: true })

const query = `query ImpactPRs($query: String!, $cursor: String) {
  search(query: $query, type: ISSUE, first: 50, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url body createdAt mergedAt additions deletions changedFiles
        author { login __typename }
        labels(first: 20) { nodes { name } }
        assignees(first: 10) { nodes { login } }
        comments { totalCount }
        files(first: 100) { nodes { path additions deletions changeType } }
        closingIssuesReferences(first: 20) { nodes { number title url } }
        reviews(first: 100) { nodes { author { login __typename } state body submittedAt } }
        reviewThreads(first: 100) {
          nodes {
            isResolved
            comments(first: 50) { nodes { author { login __typename } body createdAt } }
          }
        }
      }
    }
  }
  rateLimit { remaining resetAt cost }
}`

async function gql(variables) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'weave-posthog-impact-dashboard' },
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) throw new Error(`GitHub GraphQL HTTP ${response.status}: ${await response.text()}`)
  const payload = await response.json()
  if (payload.errors) throw new Error(JSON.stringify(payload.errors, null, 2))
  if (payload.data.rateLimit.remaining < 100) {
    console.warn(`GitHub rate limit low: ${payload.data.rateLimit.remaining} remaining; resets ${payload.data.rateLimit.resetAt}`)
  }
  return payload.data.search
}

function actor(raw) {
  if (!raw?.login) return { login: 'unknown', type: 'Unknown' }
  return { login: raw.login, type: raw.__typename === 'Bot' ? 'Bot' : raw.__typename === 'User' ? 'User' : 'Unknown' }
}

function classifyAgency(body, authorActor, assignees) {
  const text = body || ''
  const lower = text.toLowerCase()
  let agency = 'human_authored_or_unclear'
  if (/autonomy:\s*fully autonomous/i.test(text)) agency = 'fully_autonomous'
  else if (/autonomy:\s*human-driven|human-driven\s*\(agent-assisted\)|agent-assisted/i.test(text)) agency = 'human_driven_agent_assisted'
  else if (authorActor.type === 'Bot' || /i am an agent|agent-authored|authored by (claude|codex)|created with posthog code/i.test(lower)) agency = 'agent_or_bot_unclear'

  const explicit = text.match(/directed by\s+@([A-Za-z0-9-]+)/i)?.[1]
    || text.match(/—\s*@([A-Za-z0-9-]+)/)?.[1]
    || null
  let attributedHuman = explicit
  if (!attributedHuman && agency === 'human_driven_agent_assisted') {
    attributedHuman = assignees[0] || (authorActor.type === 'User' ? authorActor.login : null)
  }

  const agents = []
  const candidates = [
    ['Claude Code', /claude code/i],
    ['Claude', /\bclaude\b/i],
    ['Codex', /\bcodex\b/i],
    ['PostHog Code', /posthog code/i],
    ['Copilot', /copilot/i],
    ['Cursor', /\bcursor\b/i],
    ['Mendral', /mendral/i],
  ]
  for (const [name, pattern] of candidates) if (pattern.test(text) && !agents.includes(name)) agents.push(name)
  if (agents.includes('Claude Code')) {
    const i = agents.indexOf('Claude')
    if (i >= 0) agents.splice(i, 1)
  }
  return { agency, attributedHuman, agents }
}

function bodySignals(body) {
  const text = body || ''
  const patterns = [
    ['security', /security|vulnerab|permission|auth/i],
    ['reliability', /reliab|incident|data loss|corrupt/i],
    ['rollout safety', /rollback|feature flag|fail.closed|hardening/i],
    ['idempotency', /idempot/i],
    ['backward compatibility', /backward compat|backwards compat/i],
    ['observability', /observab|slo|monitoring|alert/i],
    ['automation', /automat|agent|scout|mcp/i],
    ['reusable primitive', /reusable|primitive|single source|shared/i],
    ['manual verification', /manual test|browser|end.to.end|e2e/i],
  ]
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
}

function evidence(body) {
  const lines = (body || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.filter((line) => /^(## (Problem|Changes|How did you test)|[-*] .{20,})/i.test(line)).slice(0, 8).map((line) => line.slice(0, 240))
}

function normalize(pr) {
  const authorActor = actor(pr.author)
  const assignees = pr.assignees.nodes.map((node) => node.login)
  const agency = classifyAgency(pr.body, authorActor, assignees)
  const threads = pr.reviewThreads.nodes ?? []
  const commentsByReviewer = new Map()
  for (const thread of threads) {
    for (const comment of thread.comments.nodes ?? []) {
      const login = comment.author?.login
      if (login) commentsByReviewer.set(login, (commentsByReviewer.get(login) || 0) + 1)
    }
  }
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    author: authorActor,
    attributedHuman: agency.attributedHuman,
    agency: agency.agency,
    agents: agency.agents,
    labels: pr.labels.nodes.map((node) => node.name),
    assignees,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    files: pr.files.nodes,
    filesTruncated: pr.changedFiles > 100,
    comments: pr.comments.totalCount,
    reviewThreads: threads.length,
    resolvedReviewThreads: threads.filter((thread) => thread.isResolved).length,
    closingIssues: pr.closingIssuesReferences.nodes,
    reviews: pr.reviews.nodes.filter((review) => review.author?.login).map((review) => ({
      author: actor(review.author),
      state: review.state,
      bodyLength: (review.body || '').trim().length,
      submittedAt: review.submittedAt,
      threadComments: commentsByReviewer.get(review.author.login) || 0,
    })),
    bodySignals: bodySignals(pr.body),
    evidence: evidence(pr.body),
  }
}

function dayStrings(start, end) {
  const days = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const last = new Date(`${end}T00:00:00Z`)
  while (cursor <= last) {
    days.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

const prs = new Map()
for (const day of dayStrings(from, to)) {
  let cursor = null
  let page = 0
  do {
    const search = await gql({ query: `repo:${REPO} is:pr is:merged merged:${day}`, cursor })
    for (const node of search.nodes.filter(Boolean)) if (node.mergedAt) prs.set(node.number, normalize(node))
    cursor = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null
    page += 1
    if (page === 1) console.log(`${day}: ${search.issueCount} merged PRs`)
  } while (cursor)
}

const grouped = new Map()
for (const pr of prs.values()) {
  const month = pr.mergedAt.slice(0, 7)
  const values = grouped.get(month) ?? []
  values.push(pr)
  grouped.set(month, values)
}

for (const [month, values] of grouped) {
  values.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))
  const shard = { month, from: values[0].mergedAt.slice(0, 10), to: values.at(-1).mergedAt.slice(0, 10), prs: values }
  await fs.writeFile(path.join(MONTHS, `${month}.json`), `${JSON.stringify(shard)}\n`)
}

let existingMonths = []
try {
  existingMonths = (await fs.readdir(MONTHS)).filter((file) => /^\d{4}-\d{2}\.json$/.test(file)).map((file) => file.slice(0, 7))
} catch {}
existingMonths.sort()

let prCount = 0
let minDate = null
let maxDate = null
for (const month of existingMonths) {
  const shard = JSON.parse(await fs.readFile(path.join(MONTHS, `${month}.json`), 'utf8'))
  prCount += shard.prs.length
  if (!minDate || shard.from < minDate) minDate = shard.from
  if (!maxDate || shard.to > maxDate) maxDate = shard.to
}
const manifest = { generatedAt: new Date().toISOString(), sourceRepo: REPO, availableMonths: existingMonths, minDate, maxDate, prCount }
await fs.writeFile(path.join(OUTPUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Collected ${prs.size} PRs for ${from}..${to}; cache now contains ${prCount} PRs across ${existingMonths.length} month(s).`)
