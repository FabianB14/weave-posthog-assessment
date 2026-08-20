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
PR Impact = Outcome × Reach × Durability + Engineering Leverage
Engineer Impact = High-impact work + Collaboration Leverage
```

- **Outcome (1–5)** — what changed for users or the system: capability, bug fix, security/reliability/data-integrity result, or structural improvement.
- **Reach (1–5)** — how broadly it can matter: user-facing/public surfaces, cross-product work, shared primitives, migrations, or developer-system changes.
- **Durability (1–5)** — evidence it will last: automated/end-to-end verification, rollout safety, idempotency, compatibility, observability, docs, and an in-window revert penalty.
- **Engineering leverage (0–25)** — reusable primitives, developer tooling, ownership, simplification, compatibility, and cross-product foundations.
- **High-impact work** — dominated by the engineer's strongest PR. Up to two additional PRs add bounded support only when they clear a high-impact threshold; low-value PRs add zero.
- **Collaboration leverage (0–80 at engineer level)** — quality-weighted evidence from up to five strongest reviews on important enriched PRs. Changes-requested feedback and substantive inline discussion matter more than a bare approval.

Raw PR count and raw review count have **zero direct weight**. They are shown only as context. Commits, lines changed, additions/deletions, and number of files are also deliberately not scoring inputs. Agent usage earns **zero** impact points.

## Coverage

The analysis window is **2026-05-22 through 2026-08-20**, a 90-day static dataset.

The static dataset preserves the evidence needed for scoring and explanation, including PR title/body-derived signals, labels, linked issues, testing/rollout evidence, revert references, author identity, human/agent attribution, and selected review evidence for collaboration leverage.

The dashboard recomputes rankings from the selected date range in-browser using the same `src/scoring.ts` rules. A long tail of small PRs or approvals cannot increase a score simply through activity volume.

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

The browser keeps already-loaded month JSON in memory. If the selected range expands, only missing month shards are requested from the deployed static site before rankings are recomputed.

There are no GitHub API requests in this flow.

## Run locally

```bash
npm install
npm run dev
```

## Deploy

GitHub Pages builds and deploys the static dashboard and checked-in JSON from `main`.
