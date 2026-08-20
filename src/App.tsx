import { useEffect, useMemo, useState } from 'react'
import { loadManifest, loadRange } from './data'
import { rankEngineers, scorePullRequest } from './scoring'
import type { DataManifest, PullRequestRecord } from './types'

function App() {
  const [manifest, setManifest] = useState<DataManifest | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [prs, setPrs] = useState<PullRequestRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetched, setFetched] = useState<string[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    loadManifest()
      .then((data) => {
        setManifest(data)
        if (!data.minDate || !data.maxDate) return
        const max = new Date(`${data.maxDate}T00:00:00Z`)
        const min90 = new Date(max)
        min90.setUTCDate(min90.getUTCDate() - 89)
        const candidate = min90.toISOString().slice(0, 10)
        setFrom(candidate < data.minDate ? data.minDate : candidate)
        setTo(data.maxDate)
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!manifest || !from || !to) return
    setLoading(true)
    loadRange(from, to, manifest.availableMonths)
      .then((result) => {
        setPrs(result.prs)
        setFetched(result.fetched)
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false))
  }, [manifest, from, to])

  const ranking = useMemo(() => rankEngineers(prs), [prs])
  const topFive = ranking.slice(0, 5)
  const agentAssisted = prs.filter((pr) => pr.agency === 'human_driven_agent_assisted').length
  const autonomous = prs.filter((pr) => pr.agency === 'fully_autonomous').length

  if (error) return <main className="shell"><div className="empty"><h1>Could not load dashboard</h1><p>{error}</p></div></main>
  if (!manifest && loading) return <main className="shell"><div className="empty">Loading impact data…</div></main>
  if (manifest && manifest.availableMonths.length === 0) {
    return <main className="shell"><div className="empty"><h1>Collector is ready</h1><p>Run <code>GH_TOKEN=… npm run collect -- --from 2026-05-22 --to 2026-08-20</code>, commit <code>public/data</code>, then refresh.</p></div></main>
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">PostHog · engineering impact</div>
          <h1>Who created the most durable leverage?</h1>
          <p className="subtitle">Outcome × reach × durability, plus engineering and collaboration leverage. Activity counts are context—not points.</p>
        </div>
        <div className="range">
          <label>From<input type="date" value={from} min={manifest?.minDate ?? undefined} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <span>→</span>
          <label>To<input type="date" value={to} min={from} max={manifest?.maxDate ?? undefined} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      </header>

      <section className="metrics">
        <Metric value={prs.length.toLocaleString()} label="merged PRs analyzed" />
        <Metric value={ranking.length.toLocaleString()} label="contributors with impact evidence" />
        <Metric value={`${Math.round((agentAssisted / Math.max(1, prs.length)) * 100)}%`} label="human-driven, agent-assisted PRs" />
        <Metric value={autonomous.toLocaleString()} label="fully autonomous PRs detected" />
      </section>

      {fetched.length > 0 && <div className="cache-note">Loaded only missing cache shards: {fetched.join(', ')}</div>}

      <section className="content-grid">
        <div className="leaderboard panel">
          <div className="section-head"><div><span className="eyebrow">Top 5</span><h2>Observed impact leaders</h2></div><span className="muted">Click a row to validate</span></div>
          {topFive.map((engineer, index) => {
            const isOpen = expanded === engineer.login
            const max = topFive[0]?.score || 1
            return (
              <article className={`engineer ${isOpen ? 'open' : ''}`} key={engineer.login}>
                <button className="engineer-main" onClick={() => setExpanded(isOpen ? null : engineer.login)}>
                  <span className="rank">{index + 1}</span>
                  <span className="identity"><strong>@{engineer.login}</strong><small>{engineer.kind === 'agent-or-bot' ? 'agent / bot identity' : `${engineer.agentAssistedImpactShare}% of authored impact agent-assisted`}</small></span>
                  <span className="scorebar"><i style={{ width: `${(engineer.score / max) * 100}%` }} /></span>
                  <span className="score"><strong>{engineer.score}</strong><small>impact</small></span>
                  <span className="chevron">{isOpen ? '−' : '+'}</span>
                </button>
                {isOpen && (
                  <div className="evidence">
                    <div className="breakdown"><span>Authored <strong>{engineer.authoredImpact}</strong></span><span>Review leverage <strong>{engineer.collaborationLeverage}</strong></span><span>{engineer.prCount} merged PRs</span><span>{engineer.reviewCount} leveraged reviews</span></div>
                    <div className="contributions">
                      {engineer.topContributions.map(({ pr, score }) => <Contribution key={pr.number} pr={pr} score={score} />)}
                    </div>
                  </div>
                )}
              </article>
            )
          })}
        </div>

        <aside className="panel method">
          <span className="eyebrow">Method</span>
          <h2>A score you can audit</h2>
          <div className="formula"><strong>PR impact</strong><span>Outcome × Reach × Durability</span><b>+</b><span>Engineering leverage</span></div>
          <p>Each PR is scored from its title/labels, changed-path topology, linked issues, tests, migrations, docs, safety/operability signals, and shared-platform work.</p>
          <p><strong>Collaboration leverage</strong> is added at the engineer level from substantive reviews on other people’s impactful PRs. Review volume alone is not rewarded.</p>
          <p><strong>Diminishing returns</strong> are applied when aggregating contributions, so dozens of tiny PRs cannot automatically outrank a few major durable changes.</p>
          <div className="warning">“Lowest impact” means lowest <em>observed GitHub impact</em> in this window—not least valuable employee. Design, mentoring, incidents, and management are under-observed.</div>
        </aside>
      </section>
      {loading && <div className="loading">Recomputing range…</div>}
    </main>
  )
}

function Contribution({ pr, score }: { pr: PullRequestRecord; score: ReturnType<typeof scorePullRequest> }) {
  return <a className="contribution" href={pr.url} target="_blank" rel="noreferrer"><div><strong>#{pr.number} {pr.title}</strong><small>{pr.agency.replaceAll('_', ' ')}{pr.agents.length ? ` · ${pr.agents.join(', ')}` : ''}</small></div><div className="dims"><span>O {score.outcome}</span><span>R {score.reach}</span><span>D {score.durability}</span><span>L +{score.engineeringLeverage}</span></div><p>{score.reasons.slice(0, 3).join(' · ')}</p></a>
}

function Metric({ value, label }: { value: string; label: string }) {
  return <div className="metric"><strong>{value}</strong><span>{label}</span></div>
}

export default App
