# Fix: paginate GitHub reviews fetch (remove 100-item hard cap)

## Context

The sync action failed on a PR with ≥100 reviews: https://github.com/dmorka/fitappo-frontend/actions/runs/24670358838/job/72139153491?pr=26

In `scripts/sync-pr.mjs:190-199`, `fetchReviews` requests a single page with `per_page=100` and **throws** if the result hits exactly 100 items:

```js
async function fetchReviews(owner, repo, number) {
  const res = await gh(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`);
  const reviews = await res.json();
  if (reviews.length === 100) {
    throw new Error(
      `fetchReviews: hit per_page=100 limit for PR #${number}; cannot reliably compute state.`
    );
  }
  return reviews;
}
```

The guard was a placeholder — real PRs hit it in practice. We need to paginate through all pages instead of erroring.

This is the **only** listing endpoint the script calls. All other GitHub/Discord calls fetch single objects or are write ops. So the fix is local to this one function.

## Approach

Replace the single-page fetch + throw with a loop that follows GitHub's RFC 5988 `Link: ...; rel="next"` header until no next page remains. Keep `per_page=100` (max) to minimize round trips.

Link-header pagination is chosen over `page` incrementing because:
- It's exact (no off-by-one on empty trailing page).
- It works cleanly with the existing dry-run stub, which returns a bare `{ ok, status, json, text }` object with no `headers` — `res.headers?.get?.("link")` yields `undefined` → loop exits on the first iteration. **No test changes required.**

### Assumptions & safeguards

- **Link absence = complete**: If GitHub returns 200 with a full 100-item page but no `rel="next"` link, we treat it as the end. This mirrors standard GitHub REST behavior — the API always includes `rel="next"` while more pages exist. A silently stripped `Link` header (e.g. by a proxy) could cause under-fetch, but that would be a broader infrastructure bug.
- **Host guard**: GitHub's `rel="next"` URLs are absolute and always point at `api.github.com`. We validate the next URL's host before following it — purely defensive against a future API change.
- **Header drift**: The new loop duplicates the request headers set by `gh()` (sync-pr.mjs:103-113) because it calls `http()` with already-absolute URLs. If `gh()` later gains headers, update this block too. A `githubHeaders()` helper would fix this but is out of scope here.

## File to modify

`scripts/sync-pr.mjs` — replace `fetchReviews` (lines 190-199) with:

```js
function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  // Format: <url>; rel="next", <url>; rel="last"
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  if (!match) return null;
  try {
    const u = new URL(match[1]);
    if (u.host !== "api.github.com") return null;
    return match[1];
  } catch {
    return null;
  }
}

async function fetchReviews(owner, repo, number) {
  const all = [];
  let url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`;
  while (url) {
    // `gh()` prepends the api.github.com host; call `http()` directly so we can
    // pass the already-absolute next-page URL returned in the Link header.
    // Headers mirror `gh()` (sync-pr.mjs:103-113) — keep in sync if `gh()` changes.
    const res = await http(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
    });
    const page = await res.json();
    all.push(...page);
    url = parseNextLink(res.headers?.get?.("link"));
  }
  return all;
}
```

Notes:
- Uses the existing `http()` helper (sync-pr.mjs:46) which already handles 429/5xx retries.
- `res.headers` exists on real `fetch` Response; absent on the dry-run stub → loop exits after first iteration, preserving test behavior.
- No new dependencies, no changes to callers (`recomputeStateFromScratch` at line 204, `review_requested` branch at line 237).

## Verification

1. **Unit tests**:
   ```sh
   node --test test/sync-pr.test.mjs
   ```
   The existing review-based tests — especially `ready_for_review with prior changes_requested review…`, `ready_for_review with no prior reviews…`, and `ready_for_review with tag already matching recomputed state…` — must still pass. The dry-run stub response has no `headers`, so `parseNextLink` returns `null` on the first iteration and the loop behaves exactly like the old single-page fetch.

2. **Multi-page unit coverage (recommended)**: add a test that stubs two sequential HTTP responses — first page with 100 items and a `Link: <…?page=2>; rel="next"` header, second page with <100 items and no `rel="next"`. Assert `fetchReviews` concatenates both. This is the only way to prove the pagination fix at the unit level; the current `DRY_RUN_REVIEWS_JSON` stub returns a single array and **cannot** exercise the multi-page path regardless of size. (A 150-item dry-run only proves the old `=== 100` guard is gone — it does not prove pagination works.)

3. **Live verification**: re-run the failing workflow on `dmorka/fitappo-frontend` PR #26 after release and confirm the job succeeds. This is the definitive end-to-end check.

## Out of scope

- No generic pagination helper — reviews is the only list endpoint called.
- No retries/backoff changes — `http()` already covers 429/5xx.
- No Discord-side pagination — the script doesn't list Discord resources in bulk.
