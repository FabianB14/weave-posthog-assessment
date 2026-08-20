# PostHog Engineering Impact Dashboard

Take-home analysis for Weave: identify the most impactful engineers in `PostHog/posthog` using explainable contribution evidence rather than raw activity counts.

## Static-data architecture

The submitted repository does **not** query `PostHog/posthog` at runtime, during CI, or during GitHub Pages deployment.

The analysis dataset is checked into `public/data/` as JSON. The React application reads only those local static files:

- `public/data/manifest.json` — covered date window and available month shards
- `public/data/months/YYYY-MM.json` — normalized PR evidence for each month
- `src/data.ts` — browser loader/cache for those static assets

No GitHub token is required to build, view, or deploy the dashboard. CI only installs dependencies and builds the app. GitHub Pages only builds and deploys the checked-in files.

## Impact model

GitHub activity is not impact. A contribution matters when it produces a meaningful outcome, reaches an important surface, survives contact with production and future change, and makes other engineers more effective.

```text
Contribution Impact = Outcome × Reach × Durability
                    + Engineering Leverage
                    + Collaboration Leverage
```

- **Outcome (1–5)** — what changed for users or the system: capability, bug fix, security/reliability/data-integrity result, or structural improvement.
- **Reach (1–5)** — how broadly it can matter: user-facing/public surfaces, cross-product work, shared primitives, migrations, or developer-system changes.
- **Durability (1–5)** — evidence it will last: automated/end-to-end verification, rollout safety, idempotency, compatibility, observability, docs, and an in-window revert penalty.
- **Engineering leverage (0–25)** — reusable primitives, developer tooling, ownership, simplification, compatibility, and cross-product foundations.
- **Collaboration leverage (0–45 at engineer level)** — substantive review work on high-impact PRs. Review volume alone is not rewarded.

Commits, lines changed, additions/deletions, and number of files are deliberately **not scoring inputs**. Agent usage also earns **zero** impact points.

## Coverage

The default analysis window is **2026-05-22 through 2026-08-20**, a 90-day window.

The static dataset preserves the evidence needed for scoring and explanation, including PR title/body-derived signals, labels, linked issues, testing/rollout evidence, revert references, author identity, human/agent attribution, and selected review evidence for collaboration leverage.

Repeated authored contributions use diminishing returns so raw PR volume does not dominate the leaderboard. Collaboration leverage is credited to reviewers rather than the PR author.

## Human + agent attribution

The JSON preserves:

- GitHub author and author type (`User` / `Bot`)
- `agency`:
  - `human_authored_or_unclear`
  - `human_driven_agent_assisted`
  - `fully_autonomous`
  - `agent_or_bot_unclear`
- explicitly attributed human/DRI when available
- detected agent/tool names

Human-driven agent-assisted work is credited to the human DRI and labeled with its agent-assisted share. Fully autonomous and ambiguous bot/agent work remains visible in a separate overlay rather than being discarded.

## Static date-range cache

The browser keeps already-loaded month JSON in memory. If May–August is loaded and a wider range is selected, only missing month shards are requested from the deployed static site before recomputing the rankings.

There are no GitHub API requests in this flow.

## Run locally

```bash
npm install
npm run dev
```

## Deploy

Merge to `main`, enable GitHub Pages with **GitHub Actions** as the source, and the Pages workflow builds/deploys the static dashboard and checked-in JSON.
