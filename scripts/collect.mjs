import fs from 'node:fs/promises'
import path from 'node:path'

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!TOKEN) throw new Error('Set GH_TOKEN (a GitHub token able to read public repositories)')

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
  return pairs
}, []))
const from = args.from
const to = args.to
const enrichLimit = Number(args.enrich ?? 400)
if (!from || !to) throw new Error('Usage: npm run collect -- --from YYYY-MM-DD --to YYYY-MM-DD [--enrich 400]')
if (new Date(from) > new Date(to)) throw new Error('--from must be <= --to')

const REPO = 'PostHog/posthog'
const API = 'https://api.github.com'
const OUTPUT = path.resolve('public/data')
const MONTHS = path.join(OUTPUT, 'months')
await fs.mkdir(MONTHS, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function githubJson(url, { search = false, attempt = 0 } = {}) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'weave-posthog-impact-dashboard',
    },
  })

  if ((response.status === 403 || response.status === 429) && attempt < 4) {
    const reset = Number(response.headers.get('x-ratelimit-reset') || 0) * 1000
    const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000
    const wait = Math.max(retryAfter, reset ? reset - Date.now() + 1500 : 0, 3000 * (attempt + 1))
    console.warn(`Rate limited on ${url}; retrying after ${Math.ceil(wait / 1000)}s`)
    await sleep(wait)
    return githubJson(url, { search, attempt: attempt + 1 })
  }
  if (!response.ok) throw new Error(`GitHub ${response.status} ${url}: ${await response.text()}`)
  const payload = await response.json()
  if (search) await sleep(2100) // Search API is limited to 30 requests/minute for authenticated callers.
  return payload
}

function actor(raw) {
  if (!raw?.login) return { login: 'unknown', type: 'Unknown' }
  return { login: raw.login, type: raw.type === 'Bot' ? 'Bot' : raw.type === 'User' ? 'User' : 'Unknown' }
}

function section(body, heading) {
  const match = (body || '').match(new RegExp(`##\\s+${heading}\\s*([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i'))
  return match?.[1]?.trim() || ''
}

function parseScope(title) {
  return title.match(/^[a-z]+\(([^)]+)\):/i)?.[1]?.toLowerCase() || null
}

function linkedIssues(body) {
  const numbers = new Set()
  for (const match of (body || '').matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)) numbers.add(Number(match[1]))
  return [...numbers]
}

function extractReferences(body) {
  const numbers = new Set()
  for (const match of (body || '').matchAll(/(?:revert(?:s|ed)?|reverting)\s+(?:https:\/\/github\.com\/PostHog\/posthog\/pull\/|#)(\d+)/gi)) numbers.add(Number(match[1]))
  return [...numbers]
}

function classifyAgency(body, authorActor, assignees) {
  const text = body || ''
  let agency = 'human_authored_or_unclear'
  if (/autonomy:\s*fully autonomous/i.test(text)) agency = 'fully_autonomous'
  else if (/autonomy:\s*human-driven|human-driven\s*\(agent-assisted\)|agent-assisted/i.test(text)) agency = 'human_driven_agent_assisted'
  else if (authorActor.type === 'Bot' || /i am an agent|agent-authored|authored by (claude|codex)|created with posthog code/i.test(text)) agency = 'agent_or_bot_unclear'

  const explicit = text.match(/directed by\s+@([A-Za-z0-9-]+)/i)?.[1] || null
  let attributedHuman = explicit
  if (!attributedHuman && agency === 'human_driven_agent_assisted') attributedHuman = assignees[0] || (authorActor.type === 'User' ? authorActor.login : null)

  const agents = []
  const candidates = [
    ['PostHog Code', /posthog code/i], ['Claude Code', /claude code/i], ['Claude', /\bclaude\b/i],
    ['Codex', /\bcodex\b/i], ['Copilot', /copilot/i], ['Cursor', /\bcursor\b/i], ['Mendral', /mendral/i],
  ]
  for (const [name, pattern] of candidates) if (pattern.test(text) && !agents.includes(name)) agents.push(name)
  if (agents.includes('Claude Code')) agents.splice(agents.indexOf('Claude'), 1)
  return { agency, attributedHuman, agents }
}

function semanticSignals(title, body, labels) {
  const text = `${title}\n${body || ''}`
  const lower = text.toLowerCase()
  const test = section(body, 'How did you test this code\\?') || section(body, 'How did you test')
  const docs = section(body, 'Docs update')
  const signals = new Set()
  const add = (name, pattern, source = lower) => { if (pattern.test(source)) signals.add(name) }

  add('new_capability', /\bfeat\b|new (?:product|capability|endpoint|surface)|ships? (?:the|a)|launch/)
  add('new_product', /new product|product skeleton|foundation for|new [a-z -]+ product/)
  add('bug_fix', /\bfix\b|bug|regression|incorrect|broken|repair/)
  add('refactor', /refactor|simplif|cleanup|restructure|single source of truth/)
  add('security', /security|vulnerab|permission|authorization|authentication|idor|prompt.injection/)
  add('reliability', /reliab|incident|outage|failure mode|stuck|race condition|deadlock/)
  add('data_integrity', /data loss|corrupt|integrity|tenant isolation|cross.tenant/)
  add('public_surface', /public api|api surface|endpoint|openapi|schema|mcp tool|sdk|webhook/)
  add('cross_product', /cross.product|repo.wide|fleet.wide|all products|shared across|every product|platform-wide/)
  add('shared_primitive', /reusable|shared primitive|shared component|single resolver|one policy engine|canonical module|common primitive|foundation/)
  add('devex', /devex|developer experience|ci\b|codeowners|ownership|preview environment|test coverage|tooling/)
  add('agent_automation', /agent|scout|reviewhog|codex|claude|mcp|self.driving|automation/)
  add('ownership', /owners\.yaml|codeowners|ownership model|owner resolver/)
  add('migration', /migration|backfill|schema change|data model/)
  add('rollout_safety', /feature flag|rollout|rollback|fail.closed|hardening|guard|throttle|rate limit|single.flight/)
  add('idempotency', /idempoten|dedup|duplicate.start|exactly.once/)
  add('backward_compat', /backward.compat|backwards.compat|replay|compatibility|fallback/)
  add('observability', /observab|monitor|slo|metrics|alert|audit log/)
  add('user_facing', /screenshot|browser|user.facing|customer|ui\b|scene|toast|modal/)
  if (/test|pytest|jest|vitest|ruff|mypy|typecheck|unit test|integration test/i.test(test)) signals.add('automated_tests')
  if (/browser|e2e|end.to.end|live|manual|local stack|smoke.test/i.test(test)) signals.add('e2e_or_live_test')
  if (/not tested|not checked|no manual testing|did not (?:run|click|exercise)/i.test(test)) signals.add('not_tested')
  if (docs && !/^(?:n\/?a|none|no\.?|not applicable)/i.test(docs.trim())) signals.add('docs_or_architecture')
  if (/architecture\.md|agents\.md|design doc|decision/i.test(lower)) signals.add('docs_or_architecture')
  if (/stacked on|\b\d+\/\d+\b|part \d+ of|follow-up/i.test(lower)) signals.add('stacked_or_followup')
  if (/^revert\b/i.test(title) || /this reverts commit|revert(?:s|ed)? #\d+/i.test(body || '')) signals.add('revert')
  if (labels.includes('automated')) signals.add('automated')
  return [...signals]
}

function evidence(body) {
  const problem = section(body, 'Problem').split(/\n+/).find((line) => line.trim())
  const changes = section(body, 'Changes').split(/\n+/).filter((line) => /^[-*]/.test(line.trim())).slice(0, 2)
  const testing = (section(body, 'How did you test this code\\?') || section(body, 'How did you test')).split(/\n+/).find((line) => line.trim())
  return [problem, ...changes, testing].filter(Boolean).map((line) => line.replace(/^[-*]\s*/, '').trim().slice(0, 220)).slice(0, 4)
}

function normalize(item) {
  const body = item.body || ''
  const authorActor = actor(item.user)
  const assignees = (item.assignees || []).map((person) => person.login)
  const attribution = classifyAgency(body, authorActor, assignees)
  const labels = (item.labels || []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean)
  const automated = labels.includes('automated') || /(?:dependabot|renovate|scheduled-actions).*\[bot\]/i.test(authorActor.login)
  return {
    number: item.number,
    title: item.title,
    url: item.html_url,
    createdAt: item.created_at,
    mergedAt: item.pull_request?.merged_at || item.closed_at,
    author: authorActor,
    attributedHuman: attribution.attributedHuman,
    agency: attribution.agency,
    agents: attribution.agents,
    labels,
    assignees,
    scope: parseScope(item.title),
    comments: item.comments || 0,
    reactions: item.reactions?.total_count || 0,
    automated,
    linkedIssues: linkedIssues(body),
    bodySignals: semanticSignals(item.title, body, labels),
    evidence: evidence(body),
    reverted: false,
    reviewsEnriched: false,
    reviews: [],
    _revertRefs: extractReferences(body),
  }
}

function enrichmentPriority(pr) {
  if (pr.automated) return -100
  const weights = {
    security: 15, reliability: 13, data_integrity: 13, new_product: 12, cross_product: 11,
    shared_primitive: 10, public_surface: 8, new_capability: 7, devex: 7, agent_automation: 5,
    rollout_safety: 5, migration: 4, automated_tests: 3, e2e_or_live_test: 3,
  }
  return pr.bodySignals.reduce((sum, item) => sum + (weights[item] || 0), 0) + Math.min(4, pr.comments / 5) + Math.min(3, pr.reactions)
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

async function searchDay(day) {
  const all = []
  let page = 1
  let total = Infinity
  while ((page - 1) * 100 < total) {
    const q = encodeURIComponent(`repo:${REPO} is:pr is:merged merged:${day}`)
    const payload = await githubJson(`${API}/search/issues?q=${q}&sort=created&order=asc&per_page=100&page=${page}`, { search: true })
    total = Math.min(payload.total_count, 1000)
    all.push(...payload.items)
    if (!payload.items.length) break
    page += 1
  }
  console.log(`${day}: ${all.length} merged PRs`)
  return all
}

const prs = new Map()
for (const day of dayStrings(from, to)) {
  for (const item of await searchDay(day)) {
    const pr = normalize(item)
    if (pr.mergedAt) prs.set(pr.number, pr)
  }
}

// Reverts are a durability signal that can be detected cheaply from the complete scan.
for (const pr of prs.values()) {
  if (!pr.bodySignals.includes('revert')) continue
  for (const number of pr._revertRefs) {
    const original = prs.get(number)
    if (original) original.reverted = true
  }
}

// Review enrichment is intentionally focused on likely high-impact changes. Every authored PR still uses the same semantic score.
const candidates = new Map()
const ordered = [...prs.values()].filter((pr) => !pr.automated).sort((a, b) => enrichmentPriority(b) - enrichmentPriority(a))
for (const pr of ordered.slice(0, enrichLimit)) candidates.set(pr.number, pr)
const bestByAuthor = new Map()
for (const pr of ordered) {
  const key = pr.attributedHuman || pr.author.login
  if (!bestByAuthor.has(key)) bestByAuthor.set(key, pr)
}
for (const pr of bestByAuthor.values()) candidates.set(pr.number, pr)

async function enrichReviews(pr) {
  const reviews = await githubJson(`${API}/repos/${REPO}/pulls/${pr.number}/reviews?per_page=100`)
  const comments = await githubJson(`${API}/repos/${REPO}/pulls/${pr.number}/comments?per_page=100`)
  const inline = new Map()
  for (const comment of comments) {
    const login = comment.user?.login
    if (!login) continue
    const current = inline.get(login) || { count: 0, length: 0 }
    current.count += 1
    current.length += (comment.body || '').trim().length
    inline.set(login, current)
  }
  const aggregate = new Map()
  for (const review of reviews) {
    const login = review.user?.login
    if (!login) continue
    const current = aggregate.get(login) || { author: actor(review.user), states: [], bodyLength: 0, submittedAt: null }
    current.states.push(review.state)
    current.bodyLength += (review.body || '').trim().length
    current.submittedAt = review.submitted_at || current.submittedAt
    aggregate.set(login, current)
  }
  pr.reviews = [...aggregate.entries()].map(([login, value]) => {
    const states = value.states.map((state) => state.toUpperCase())
    const state = states.includes('CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : states.includes('APPROVED') ? 'APPROVED' : states[0] || 'COMMENTED'
    const inlineStats = inline.get(login) || { count: 0, length: 0 }
    return { author: value.author, state, bodyLength: value.bodyLength, inlineComments: inlineStats.count, inlineCommentLength: inlineStats.length, submittedAt: value.submittedAt }
  })
  pr.reviewsEnriched = true
}

const queue = [...candidates.values()]
const workers = Array.from({ length: 5 }, async () => {
  while (queue.length) {
    const pr = queue.shift()
    if (!pr) break
    try {
      await enrichReviews(pr)
    } catch (error) {
      console.warn(`Review enrichment failed for #${pr.number}: ${error}`)
    }
    await sleep(80)
  }
})
await Promise.all(workers)

const grouped = new Map()
for (const pr of prs.values()) {
  delete pr._revertRefs
  const month = pr.mergedAt.slice(0, 7)
  const values = grouped.get(month) || []
  values.push(pr)
  grouped.set(month, values)
}

for (const [month, values] of grouped) {
  values.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))
  const shard = { month, from: values[0].mergedAt.slice(0, 10), to: values.at(-1).mergedAt.slice(0, 10), prs: values }
  await fs.writeFile(path.join(MONTHS, `${month}.json`), `${JSON.stringify(shard)}\n`)
}

const availableMonths = [...grouped.keys()].sort()
const manifest = {
  generatedAt: new Date().toISOString(),
  sourceRepo: REPO,
  availableMonths,
  minDate: from,
  maxDate: to,
  prCount: prs.size,
  reviewEnrichedPrs: [...prs.values()].filter((pr) => pr.reviewsEnriched).length,
  methodologyVersion: 'semantic-v2',
}
await fs.writeFile(path.join(OUTPUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Collected ${prs.size} merged PRs; enriched ${manifest.reviewEnrichedPrs} for collaboration evidence.`)
