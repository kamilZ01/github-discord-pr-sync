---
name: Fix Section 2 docs
overview: Update README.md for composite-action accuracy (D1), correct script size wording (D2), reliable test command (D5), E2E checklist accuracy after C1–C3 fixes, and T1/T2 single-tag caveat. D3/D4 (former SECURITY_REVIEW.md) are out of scope because that file was deleted. Optionally align test/sync-pr.test.mjs header comment with D5.
todos:
  - id: d1-readme-composite
    content: "README: replace reusable-workflow wording + update How it works diagram for composite action / uses:"
    status: pending
  - id: d2-readme-lines
    content: "README: fix script line count (wc -l at edit time) or remove exact number"
    status: pending
  - id: d5-readme-tests
    content: "README: add Tests subsection with node --test test/sync-pr.test.mjs; optionally fix test file header comment"
    status: pending
  - id: checklist-update
    content: "README: update E2E verification checklist to reflect C1–C3 fixes (ready_for_review and approve now recompute state)"
    status: pending
  - id: t1-t2-caveat
    content: "README Caveats: add single-tag behavior note (T1/T2 — each sync replaces all applied_tags with one lifecycle tag)"
    status: pending
isProject: false
---

# Documentation fixes: Section 2 (README-only)

Original audit: [docs/COMPLETE_REVIEW_REPORT.md](COMPLETE_REVIEW_REPORT.md) Section 2 listed **D1–D5**. **D3 and D4** targeted `SECURITY_REVIEW.md`, which is **deleted**—those items are **out of scope** for this plan (no updates to that file).

This plan covers **D1, D2, and D5** in [README.md](../README.md) only.

---

## D1 — README: “reusable workflow” vs composite action

**Problem:** [README.md](../README.md) lines 7–8, 10–11, and the ASCII diagram (lines 15–19) describe a **reusable workflow** in this repo. The shipped integration is a **composite action** defined in [action.yml](../action.yml) (`runs.using: composite`), invoked from the **consumer** workflow via `uses: org/repo@ref` (as in README lines 96–101). There is no `workflow_call` entrypoint in this repo.

**Edits (README):**

1. **Opening bullets (lines 7–11):** Replace “reusable workflow” with **composite action** (or “GitHub Actions composite action”). Keep “caller workflow” phrasing where it refers to the **consumer** repo’s `.github/workflows/...`.
2. **Diagram (lines 15–28):** Change the middle box from “reusable workflow in this repo” to something accurate, e.g. **“composite action (this repo)”** or **“Discord PR Sync action”**, with an arrow label like **“uses: org/repo@ref”** so readers see the difference from a reusable workflow.
3. **Optional clarity sentence** after the diagram: One line stating that GitHub resolves `github.action_path` to this action’s files (no checkout of this repo required in the consumer workflow for the script itself).

**Do not** claim a reusable workflow exists unless you actually add `.github/workflows/*.yml` with `workflow_call` later.

---

## D2 — README: stale line count

**Problem:** Line 8 says “~280-line”; [scripts/sync-pr.mjs](../scripts/sync-pr.mjs) is on the order of **~400 lines** (exact count drifts).

**Edit:** Replace with a **rounded, honest** figure (e.g. “~400-line” or “single-file (~400 lines)”) or drop the number and say “single Node script.” Re-run `wc -l scripts/sync-pr.mjs` at edit time and paste the current approximate value to avoid immediate staleness.

---

## D5 — README: known-good test command

**Problem:** Running `node --test test/` can fail on some Node versions (directory treated as a module). The audit asked for a **documented, reliable** command.

**Edits (README):**

1. Add a short **“Tests”** subsection (after Local dry-run or before License), e.g.:
   - Command: `node --test test/sync-pr.test.mjs`
   - Optional: `node --test test/**/*.mjs` if you verify it on supported Node versions.
2. **Optional consistency:** Update the header comment in [test/sync-pr.test.mjs](../test/sync-pr.test.mjs) line 2, which currently says `node --test test/`, to match the README so future readers are not misled.

---

## Checklist update — E2E verification (after C1–C3 fixes)

**Problem:** [README.md](../README.md) lines 140–151 — the End-to-end verification checklist assumes `ready_for_review` always produces **Open** and `Approve` always produces **Approved**. After C1–C3 fixes, `ready_for_review`, `reopened`, and `approved` now call `recomputeStateFromScratch`, meaning the tag depends on aggregate review state. The checklist needs nuance for multi-reviewer scenarios.

**Edits (README):**

1. **Line 145** ("Mark ready for review → tag flips to Open"): Clarify this holds when there are no blocking reviews. Add a note: in multi-reviewer scenarios where reviews persist from the draft phase, the tag may reflect the aggregate state (e.g. `Changes Requested`).
2. **Line 149** ("Submit an Approve review → tag flips to Approved"): Clarify this holds when no other reviewer has `Changes Requested` outstanding.

Keep the checklist simple — these are the expected results for the **single-reviewer happy path**. Add a brief note after the checklist acknowledging multi-reviewer edge cases.

---

## T1/T2 — Single-tag behavior caveat

**Problem:** [COMPLETE_REVIEW_REPORT.md](COMPLETE_REVIEW_REPORT.md) Section 4 notes that `updateThreadTags` sends `applied_tags: [tagId]` — a full replace. Manual extra forum tags added by humans or other integrations are overwritten on the next sync. This is by design but surprising unless documented.

**Edit (README Caveats section, line ~153):** Add one bullet:

> - Each sync event sets **exactly one** lifecycle forum tag on the thread. Any other forum tags manually added to the thread will be removed on the next update.

---

## Cross-reference (out of this plan’s scope)

**Optional:** If you still want security or supply-chain notes in-repo, add a short **README** subsection (e.g. pinning `uses:` to a SHA, fork secrets) rather than restoring `SECURITY_REVIEW.md`—not required for D1/D2/D5.

---

## Verification checklist (for the implementer)

- [ ] README uses **composite action** terminology consistently; diagram matches `uses:` flow.
- [ ] Line count or wording for script size is accurate (run `wc -l scripts/sync-pr.mjs` at edit time).
- [ ] README documents `node --test test/sync-pr.test.mjs` (and test file header comment updated if desired).
- [ ] E2E verification checklist reflects `recomputeStateFromScratch` behavior for `ready_for_review` and `approved`.
- [ ] Caveats section includes single-tag behavior note (T1/T2).
- [ ] Quick read-through: no incorrect **reusable workflow** claims for **this** repo’s artifact.
- [ ] Consumer workflow example (lines 82–102) already uses `uses: kamilZ01/github-discord-pr-sync@v2` — confirm it is unchanged and consistent with new intro wording.
