# PostHog Engineering Impact Dashboard

Take-home analysis for Weave: identify the most impactful engineers in `PostHog/posthog` using explainable contribution evidence rather than raw activity counts.

## Impact model

The dashboard scores merged pull requests using the same model everywhere:

```text
Contribution Impact = Outcome × Reach × Durability
                    + Engineering Leverage
                    + Collaboration Leverage
```

Each dimension is scored from observable GitHub evidence and rendered with the evidence that produced it. Counts such as commits, lines changed, and files touched are context only; they are not direct impact points.

### Dimensions

- **Outcome** — what shipped: user-facing capability, reliability/security fix, bug fix, infrastructure/platform improvement, or maintenance.
- **Reach** — how broadly the change can matter: product surface, shared/core paths, cross-product infrastructure, public API/schema, migrations, CI/developer platform.
- **Durability** — evidence the contribution lasts: tests, migrations/backward compatibility, documentation/ownership, rollout safety, observability, and absence of a near-term revert.
- **Engineering leverage** — makes future engineering cheaper/faster/safer: reusable primitives, tooling, automation, architecture simplification, ownership, CI, agent infrastructure.
- **Collaboration leverage** — multiplies others: substantive reviews, resolving design/review threads, unblocking stacked work, and cross-team coordination.

The engineer ranking uses diminishing returns so a high volume of tiny PRs cannot overwhelm a few genuinely high-impact contributions.

## Human + agent attribution

The collector preserves:

- GitHub `author`
- author type (`User` / `Bot`)
- `agency`:
  - `human_authored_or_unclear`
  - `human_driven_agent_assisted`
  - `fully_autonomous`
  - `agent_or_bot_unclear`
- explicitly attributed human/DRI when the PR description provides one
- detected agent/tool names when present (Claude Code, Codex, PostHog Code, etc.)

Human-driven agent-assisted work remains credited to the human DRI for the engineer leaderboard while the dashboard separately shows how much observed impact was agent-assisted. Fully autonomous work can appear as an agent row.

## Data architecture

The collector writes month-level shards to `public/data/months/YYYY-MM.json` plus `public/data/manifest.json`.

The browser caches loaded shards. If May–August is already loaded and the user selects January–August, it requests only January–April, merges those shards, and runs the exact same scoring function over the expanded range.

This keeps GitHub Pages static, avoids exposing a GitHub token in the browser, and makes repeat range changes fast.

## Development

```bash
npm install
GH_TOKEN=... npm run collect -- --from 2026-05-22 --to 2026-08-20
npm run dev
```

The collector uses GitHub's REST API and is intended to run with a token locally or in GitHub Actions.
