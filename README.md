# PostHog Engineering Impact Dashboard

Take-home analysis for Weave: identify the most impactful engineers in `PostHog/posthog` using explainable contribution evidence rather than raw activity counts.

## Thesis

GitHub activity is not impact. A contribution matters when it produces a meaningful outcome, reaches an important surface, survives contact with production and future change, and makes other engineers more effective.

```text
Contribution Impact = Outcome × Reach × Durability
                    + Engineering Leverage
                    + Collaboration Leverage
```

- **Outcome (1–5)** — what changed for users or the system: capability, bug fix, security/reliability/data-integrity result, or structural improvement.
- **Reach (1–5)** — how broadly it can matter: user-facing/public surfaces, cross-product work, shared primitives, migrations, or developer-system changes.
- **Durability (1–5)** — evidence it will last: automated + end-to-end verification, rollout safety, idempotency, compatibility, observability, docs, and a penalty for an in-window revert.
- **Engineering leverage (0–25)** — reusable primitives, devex/CI/ownership, automation/agent infrastructure, simplification, and cross-product foundations.
- **Collaboration leverage (0–45 at engineer level)** — substantive review work on high-impact PRs. Review volume alone is not rewarded.

Commits, lines changed, additions/deletions, and number of files are deliberately **not scoring inputs**.

## Why the collector is two-pass

The 90-day PostHog window contains well over ten thousand merged PRs, so fetching every diff, inline thread, and review would be slow and wasteful for a 90-minute take-home.

1. **Complete semantic scan:** every merged PR in the selected dates is fetched via GitHub Search and reduced to semantic evidence from its Problem / Changes / testing text, labels, linked issues, author + agency attribution, rollout safeguards, and revert references.
2. **Focused collaboration enrichment:** the strongest candidate PRs (plus each contributor's strongest candidate) are enriched with actual GitHub reviews and inline review comments. This is only used for collaboration leverage; authored-impact scoring remains complete across every PR.

That gives complete coverage for the question “who shipped impactful work?” while spending deeper API calls where they add information rather than activity noise.

## Human + agent attribution

PostHog PRs often carry explicit `## 🤖 Agent context` and `Autonomy:` metadata. The collector stores:

- GitHub author and author type (`User` / `Bot`)
- `agency`:
  - `human_authored_or_unclear`
  - `human_driven_agent_assisted`
  - `fully_autonomous`
  - `agent_or_bot_unclear`
- explicitly attributed human/DRI when present (assignee/`directed by @…`)
- detected agent/tool names (Claude Code, Codex, PostHog Code, etc.)

Agent use itself earns **zero** points. Human-driven agent-assisted work is credited to the human DRI for the engineer leaderboard and labeled with its agent-assisted share. Fully autonomous/bot identities are preserved in a separate overlay instead of thrown away.

## Incremental date-range cache

The collector writes month shards to `public/data/months/YYYY-MM.json` plus `public/data/manifest.json`.

The browser keeps already-loaded months in memory. If May–August is loaded and the leader selects January–August, the app requests only January–April and recomputes the leaderboard with the exact same `src/scoring.ts` functions.

This keeps GitHub Pages static and fast and never exposes a GitHub token in the browser.

## Run it

```bash
npm install
GH_TOKEN=... npm run collect -- --from 2026-05-22 --to 2026-08-20 --enrich 400
npm run dev
```

Or run the **Collect PostHog data** GitHub Action. A `POSTHOG_GH_TOKEN` repository secret is supported; the workflow falls back to `github.token` if it can read the public source repo.

## Deploy

Merge to `main`, enable GitHub Pages with **GitHub Actions** as the source, and the Pages workflow builds/deploys the static dashboard.
