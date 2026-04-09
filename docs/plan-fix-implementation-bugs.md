# Plan: Fix Section 1 implementation bugs (C1–C9)

**Goal:** Fix all 9 implementation bugs identified in `docs/COMPLETE_REVIEW_REPORT.md` Section 1.

**Priority order:** C1–C3 (High) → C4, C7 (Medium) → C5, C8, C9 (Low). C6 is a dry-run cosmetic issue — no change.

---

## C1 (High) — `approved` review ignores other reviewers' state

**Where:** `scripts/sync-pr.mjs`, `computeDesiredState`, line 192

**Bug:** When reviewer A submits `approved`, the script returns `"Approved"` without checking if reviewer B's latest review is still `CHANGES_REQUESTED`. GitHub shows the PR as "changes requested" in this case.

**Fix:** Replace the direct return with `recomputeStateFromScratch(pr, owner, repo)`. The `changes_requested` path (line 191) can stay as a direct return — if anyone requests changes, that always wins regardless of other reviews, matching `recomputeStateFromScratch` logic.

```js
// line 189-192, change to:
if (action === "submitted") {
  const s = event.review.state;
  if (s === "changes_requested") return "Changes Requested";
  if (s === "approved") return await recomputeStateFromScratch(pr, owner, repo);
  if (s === "commented") return null;
}
```

---

## C2 (High) — `ready_for_review` ignores existing reviews

**Where:** `scripts/sync-pr.mjs`, `computeDesiredState`, line 172

**Bug:** A PR in draft with existing `CHANGES_REQUESTED` reviews is marked ready → script says "Open" but GitHub still shows changes requested.

**Fix:** Replace with `recomputeStateFromScratch(pr, owner, repo)`.

```js
// line 172, change to:
if (action === "ready_for_review") return await recomputeStateFromScratch(pr, owner, repo);
```

---

## C3 (High) — `reopened` ignores persisted reviews

**Where:** `scripts/sync-pr.mjs`, `computeDesiredState`, lines 173–174

**Bug:** Reopened PR may still have `CHANGES_REQUESTED`/`APPROVED` reviews. Script ignores them.

**Fix:** For `reopened`, call `recomputeStateFromScratch`. For `opened`, keep current behavior (no reviews can exist yet on a brand-new PR).

```js
// lines 173-175, change to:
if (action === "opened") return pr.draft ? "Draft" : "Open";
if (action === "reopened") return await recomputeStateFromScratch(pr, owner, repo);
```

---

## C4 (Medium) — No pagination for reviews

**Where:** `scripts/sync-pr.mjs`, `fetchReviews`, lines 130–138

**Bug:** Only fetches first 100 reviews. Warning is logged but wrong state can still be computed.

**Fix:** Fail closed — throw instead of warn when limit is hit. Makes the failure explicit rather than silently wrong.

```js
// line 133-136, change console.warn to throw:
if (reviews.length === 100) {
  throw new Error(
    `fetchReviews: hit per_page=100 limit for PR #${number}; cannot reliably compute state.`
  );
}
```

---

## C5 (Low) — Null user in review can throw

**Where:** `scripts/sync-pr.mjs`, `recomputeStateFromScratch`, line 145

**Bug:** `reviews.filter((r) => !isBot(r.user))` passes null-user reviews through, then `r.user.login` on line 149 throws.

**Fix:** Filter out reviews with no `user` alongside the bot filter.

```js
// line 145, change to:
const humanReviews = reviews.filter((r) => r.user && !isBot(r.user));
```

---

## C6 (Low, dry-run only) — Spurious PATCH+POST under `--dry-run`

**Where:** `scripts/sync-pr.mjs`, lines 377–381

**Bug:** `currentTags` stays `[]` under dry-run because `getThread` is skipped, so the "tag already correct" short-circuit never fires.

**Decision: No change.** The dry-run output showing the would-be PATCH/POST is arguably useful — it shows what *would* happen. Cosmetic only.

---

## C7 (Medium) — `ensureLabel` swallows all 422 errors

**Where:** `scripts/sync-pr.mjs`, `ensureLabel`, lines 229–231

**Bug:** GitHub returns 422 for multiple validation failures, not just "already exists" (e.g. name too long, invalid characters). All are silently swallowed.

**Fix:** Check for the specific "already_exists" error code in the error message (the response body is embedded by `http()` in `err.message`).

```js
// lines 229-231, change to:
} catch (err) {
  const alreadyExists = err.status === 422 && err.message.includes("already_exists");
  if (!alreadyExists) throw err;
}
```

---

## C8 (Low) — Multiple `discord-thread:` labels → nondeterministic

**Where:** `scripts/sync-pr.mjs`, `findThreadIdFromLabels`, lines 208–214

**Bug:** If two `discord-thread:` labels exist, the first match in API order wins — nondeterministic.

**Fix:** Warn if duplicates are detected. **Invariant: always return the first matching label's id.** The loop must capture the first id, then break on any subsequent match after warning — it must never overwrite `found` after the warning.

```js
function findThreadIdFromLabels(pr) {
  let found = null;
  for (const lbl of pr.labels || []) {
    if (lbl.name && lbl.name.startsWith(THREAD_LABEL_PREFIX)) {
      if (found) {
        // Invariant: never overwrite `found` — always use the first match.
        console.warn(`Multiple ${THREAD_LABEL_PREFIX} labels found; using first: ${found}`);
        break;
      }
      found = lbl.name.slice(THREAD_LABEL_PREFIX.length);
    }
  }
  return found;
}
```

---

## C9 (Low) — Fork skip fails when `head.repo` is null

**Where:** `scripts/sync-pr.mjs`, line 322

**Bug:** If `pr.head.repo` is null (deleted fork), `full_name` is undefined, the `&&` short-circuits, and the PR is **not** skipped.

**Fix:** Invert logic — skip unless we can confirm the PR is from the same repo.

**Tradeoff:** This is a conservative skip. If a same-repo PR ever arrives with `head.repo` missing (rare — broken webhook or deleted repo edge case), it will be skipped even though it's not a fork. We accept this because: (a) a missing `head.repo` likely means the PR is in a broken state anyway, (b) skipping is safe (the PR just won't get a Discord thread), and (c) the alternative (proceeding without verification) risks leaking secrets to a fork PR. A code comment should document this tradeoff.

```js
// lines 322-325, change to:
const headRepo = pr.head?.repo?.full_name;
if (headRepo && headRepo !== repoFull) {
  console.log("Fork PR; skipping.");
  return;
}
if (!headRepo) {
  // Conservative: skip if we can't confirm same-repo origin. This may skip
  // rare same-repo PRs with a broken/missing head.repo payload, but that's
  // safer than proceeding without verification (fork secret-leak risk).
  console.log("PR head repo unknown (possibly deleted fork); skipping.");
  return;
}
```

---

## Test plan

### Testable with current dry-run subprocess pattern

| Bug | Test |
|-----|------|
| **C8** | Fixture with two `discord-thread:` labels → assert warning in stdout |
| **C9** | Fixture with `head.repo: null` → assert "head repo unknown" skip message |

### Not testable without mock HTTP layer

C1, C2, C3 fixes change paths that now call `recomputeStateFromScratch`, which makes a live GET to GitHub's review API. The dry-run flag only intercepts mutating requests (POST/PATCH/etc.), not GETs. These fixes are verified by:

- Code inspection: confirm the 3 paths call `recomputeStateFromScratch`
- Existing tests still pass (no regression)
- Manual end-to-end verification (see README checklist)

### Files to modify

| File | Changes |
|------|---------|
| `scripts/sync-pr.mjs` | C1–C5, C7–C9 fixes |
| `test/sync-pr.test.mjs` | C8, C9 regression tests |

### Verification

1. `node --test test/sync-pr.test.mjs` — all existing + new tests pass
2. Code review: `approved` / `ready_for_review` / `reopened` paths call `recomputeStateFromScratch`
3. Code review: `fetchReviews` throws at 100 limit
4. Code review: null-user filter in `recomputeStateFromScratch`
5. Code review: `ensureLabel` checks for `already_exists` string
6. Code review: `findThreadIdFromLabels` warns on duplicates
7. Code review: fork skip handles null `head.repo`
