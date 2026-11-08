# AGENTS.md

A GitHub Actions composite action that mirrors PRs into a Discord forum channel. `action.yml`
runs `scripts/sync-pr.mjs` on the consumer's runner, once per PR event. README.md is the
consumer-facing guide.

**Before you write or review a change, read [CODING_STANDARDS.md](CODING_STANDARDS.md).**

## Checks

Run every command in `.github/workflows/test.yml` before you push. CI runs the same ones.

CI never runs `action.yml`. To change it, or to bump an action pinned in it, read that
action's `action.yml` and source at the pinned SHA, and quote what you relied on in the PR's
Evidence.

## Releases reach consumers only through tags

- Consumers pin a release commit SHA (`@<sha> # vX.Y.Z`), so a merge to `main` changes
  nothing for them until a new tag ships.
- Release tags are annotated and immutable: `vX.Y.Z`, message `vX.Y.Z — <headline>`.
- After a tag ships, open a docs PR that points the README's caller workflow at the tag's
  commit SHA (`git rev-list -n1 vX.Y.Z`). That `uses:` line is the README's only copy of
  the SHA, and Dependabot never edits the README.
- `v1` is frozen at v1.3.3 and the README tells consumers so. Leave it where it is. Tagging
  is the maintainer's call, so ask before you create one.

## Git

- Branches are `<type>/<topic>`: `feat/`, `fix/`, `ci/`, `docs/`.
- Commits have an imperative headline and a body that explains why.
- PR bodies have three sections: **Summary** (a diff sketch or call tree of the change),
  **Evidence** (before/after: test output, dry-run output, or quoted upstream source),
  **Merge Danger** (one-way or two-way door, plus blast radius).
- When you refer to an issue or PR in another repo, write `owner/repo#n`. Consumer repos
  live under other owners.

## Docs

- When behaviour a consumer can see changes, update README.md in the same PR: Caveats, the
  caller workflow, or the end-to-end checklist.
- Name runtimes and requirements in the README, not versions of actions pinned in
  `action.yml`. Dependabot bumps the pin and leaves the README alone.
- `docs/fix-reviews-pagination.md` is a plan for a fix that has already shipped. Its code and
  line numbers are out of date, so read the current code instead.
