# Complete code review report — github-discord-pr-sync

**Scope:** `scripts/sync-pr.mjs`, `action.yml`, `test/sync-pr.test.mjs`, `README.md`, `SECURITY_REVIEW.md`, fixtures.  
**Date:** 2026-04-09 (review pass).

This document lists **implementation bugs**, **documentation bugs**, **security-related findings** (including tradeoffs and stale docs), and **design limitations** (including Discord single-tag behavior). Items are separate so you can triage by type.

---

## 1. Implementation bugs (correctness & reliability)

These are defects in code behavior or error handling under realistic use.


| ID     | Severity      | Summary                                                                                                                                                                                                                                                                          |
| ------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** | High          | `pull_request_review` + `submitted` + `approved` sets Discord tag to **Approved** without aggregating other reviewers. If another human’s latest review is still `CHANGES_REQUESTED`, the effective GitHub state remains “changes requested,” but the script shows **Approved**. |
| **C2** | High          | `pull_request` + `ready_for_review` always returns **Open**, ignoring existing reviews (e.g. PR still has changes requested after returning from draft).                                                                                                                         |
| **C3** | High          | `pull_request` + `reopened` returns only **Draft** vs **Open** and does not recompute from persisted reviews; reopened PRs can still be **Changes Requested**, **Approved**, etc.                                                                                                |
| **C4** | Medium        | `fetchReviews` uses `per_page=100` only; no pagination. With more than 100 reviews, `recomputeStateFromScratch` and `review_requested` paths can compute the **wrong** tag (only a console warning).                                                                             |
| **C5** | Low           | `recomputeStateFromScratch`: if a review object ever lacks `user`, `r.user.login` can **throw** (`isBot(null)` is false).                                                                                                                                                        |
| **C6** | Low (dry-run) | Under `--dry-run`, `currentTags` is never loaded (`getThread` skipped), so the “tag already correct” short-circuit never runs → **spurious PATCH + POST** on every update path for existing threads.                                                                             |
| **C7** | Medium        | `ensureLabel` ignores **all** HTTP **422** responses, assuming “label already exists.” Other validation failures also return 422 and would be **silently swallowed**.                                                                                                            |
| **C8** | Low           | Multiple `discord-thread:*` labels: `findThreadIdFromLabels` picks the **first** match in API order → **nondeterministic** thread if duplicates exist.                                                                                                                           |
| **C9** | Low           | Fork skip requires `pr.head.repo.full_name`; if missing (e.g. deleted head repo, trimmed payload), the script may **not** skip a fork PR as intended.                                                                                                                            |


**Reference (C1):** `computeDesiredState` for `pull_request_review` / `submitted` maps only `event.review.state` to a tag instead of calling `recomputeStateFromScratch` (or equivalent) for `approved`.

**Note:** Snowflake validation for `discord-thread:` values is applied on the main update path and on the title-edit path in the current tree; earlier review notes about the title-edit path skipping validation are **obsolete** for this revision.

---

## 2. Documentation bugs (README vs repository reality)

These are **incorrect or misleading statements** in docs, not optional opinions.


| ID     | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D1** | **README** repeatedly says the integration runs as a **“reusable workflow”** and the diagram shows **“reusable workflow in this repo.”** The shipped artifact is a **composite action** (`action.yml` with `runs.using: composite`). Callers use `uses: org/repo@vN`, not `workflow_call`. Wording and diagram should say **composite action** (or both models if you reintroduce a reusable workflow).                                                                        |
| **D2** | **README** bullet: “A single **~280-line** Node 20 script” — `scripts/sync-pr.mjs` is **~396 lines** as counted in the review pass. Stale line count undermines trust in other numbers.                                                                                                                                                                                                                                                                                        |
| **D3** | **SECURITY_REVIEW.md** describes assessing `**/.github/workflows/sync.yml`**, checkout of **this repo at `main`**, and consumer pattern that does not match the **composite action** model in this workspace (no `.github/workflows/sync.yml` in tree; consumers do not check out this repo to run the script—the action path is resolved by GitHub from the action ref). Several threat-model paragraphs are **historical or inaccurate** for the current delivery mechanism. |
| **D4** | **SECURITY_REVIEW.md** § “`discord-thread:` label value is not validated” — the script **does** validate with `assertValidDiscordSnowflake` (`/^\d{5,25}$/`) on standard and title-edit paths before Discord writes. The doc should be **updated** to reflect validation (and any remaining gaps, e.g. multiple labels).                                                                                                                                                       |
| **D5** | **README** “Local dry-run” says GitHub reads still hit the network for some fixtures; the **test file** recommends `node --test test/sync-pr.test.mjs` (or similar). Running `node --test test/` failed on one Node version (directory resolved as a module). README should give a **known-good** test command.                                                                                                                                                                |


---

## 3. Security findings (tradeoffs, residual risk, doc alignment)

Treated here as **valid issues** where they represent gaps, stale guidance, or decisions operators must understand—not necessarily “patch today” code bugs.


| ID     | Type            | Summary                                                                                                                                                                                                                                                     |
| ------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1** | Supply chain    | Consumers pinning `@v2` (mutable tag) inherit **moving code** on tag retag. README already recommends SHA pinning; **SECURITY_REVIEW** still emphasizes checkout/`main` in places—should be reconciled with **action ref pinning**.                         |
| **S2** | Operational     | `http()` errors include **method, URL, status, truncated body** — useful for debugging; bodies could rarely contain **sensitive fragments**. Acceptable for many teams; document as a **logging tradeoff**.                                                 |
| **S3** | Content / abuse | PR **title, body snippet, branch names, logins** are mirrored into Discord. No RCE in the script; risk is **Discord-side abuse, misleading content, moderation** — already noted in SECURITY_REVIEW; worth a one-line **README caveat** if you want parity. |
| **S4** | Trust boundary  | `**discord-thread:`** mapping labels: anyone who can set labels on the PR can **point automation at another thread ID** (snowflake validation limits format, not **authorization**). Org **label permissions** matter.                                      |
| **S5** | Fixed hosts     | **Positive:** `gh()` / `discord()` only target GitHub and Discord APIs — **no user-controlled base URL** (classic SSRF via payload is not a concern for those helpers).                                                                                     |


---

## 4. Discord design: single `applied_tags` entry

The implementation intentionally sets **one** forum tag per lifecycle update.

**Behavior in code:**

- `createForumThread` sends `applied_tags: [tagId]` (single id).
- `updateThreadTags` sends `applied_tags: [tagId]` — a full replace for the thread’s applied tags in that API shape.

**Valid “bugs” / product limitations for operators:**


| ID     | Summary                                                                                                                                                                                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1** | **Manual extra forum tags are overwritten.** If a human (or another integration) adds a second forum tag on the thread, the next sync **replaces** `applied_tags` with a **single** tag, dropping additional tags. This is **by current design** but is a **surprising footgun** unless documented. |
| **T2** | **Lifecycle is modeled as mutually exclusive states** in one dimension (one tag at a time). That matches the seven named tags but **cannot** represent combinations (e.g. “Open” + custom “security” tag) without code changes.                                                                     |


**Recommendation:** Add a short **README caveat**: “Each sync sets exactly one lifecycle forum tag; other applied tags on the thread may be removed on update.”

---

## 5. README checklist vs known code bugs

The **End-to-end verification checklist** in README assumes:

- Ready for review → tag **Open** — may **fail** if reviews still request changes (**C2**).
- Approve → **Approved** — may **fail** if another reviewer still has changes requested (**C1**).
- Reopen flows — may **fail** to match expectations if reviews persist (**C3**).

So the checklist can **pass in simple scenarios** but **contradict actual GitHub state** in multi-reviewer cases until **C1–C3** are fixed.

---

## 6. Suggested priority order

1. **Fix C1–C3** (aggregate review state consistently — reuse `recomputeStateFromScratch` where needed).
2. **Fix C4** (paginate reviews) or **fail closed** when `reviews.length === 100`.
3. **Fix D1–D4** (README + SECURITY_REVIEW accuracy).
4. **Fix C7** (narrow 422 handling or inspect error body for “already exists”).
5. **Document T1–T2** (and optionally **C6** for dry-run users).
6. **Harden C8–C9** if your org needs stricter mapping/fork behavior.

---

## 7. Files referenced


| Path                    | Role                                  |
| ----------------------- | ------------------------------------- |
| `scripts/sync-pr.mjs`   | Main implementation                   |
| `action.yml`            | Composite action definition           |
| `test/sync-pr.test.mjs` | Subprocess + dry-run tests            |
| `README.md`             | User-facing setup and caveats         |
| `SECURITY_REVIEW.md`    | Security assessment (partially stale) |
| `fixtures/*.json`       | Webhook-shaped test payloads          |


---

*Generated as a consolidated audit; re-run review after significant refactors.*