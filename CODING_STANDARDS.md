# Coding standards

These rules come from the existing code, so most of them already hold. Each one says why, so
you can tell when a case falls outside it. No formatter or linter is set up, so nothing here
is checked by tooling.

## Runtime: zero dependencies

- Use Node built-ins only, imported with the `node:` prefix, and built-in `fetch`. The action
  runs straight from the pinned checkout with no install step, so a package would never be
  present.
- Keep the repo free of `package.json`. If one lands that names npm in `packageManager` (or
  `devEngines.packageManager`) and has no lockfile, setup-node's auto-cache fails the
  `test.yml` job, which has no `package-manager-cache: false`.
- Target the Node major set in `action.yml` (`node-version`). Scripts are ES modules (`.mjs`)
  run as `node <file>`.

## Layout and style

- `sync-pr.mjs` is one file, split into sections with `// ---------- <Name> ----------`
  headers. Put new code in the section it belongs to, or add a section.
- Use 2-space indentation, double quotes, semicolons and trailing commas in multiline
  literals. Wrap at about 100 columns.
- Use camelCase for functions and variables and SCREAMING_SNAKE for module constants. Read
  env vars once, in the `process.env` destructure at the top.
- In request and response bodies, keep the API's own field names (`applied_tags`,
  `allowed_mentions`, `thread_metadata`). Keep your own variables camelCase.
- Comments explain why: an API contract, an event's semantics, an ordering constraint. Name
  the source, e.g. Discord error 50083 or "GitHub fires a separate review_requested
  event". When a comment and the code disagree, fix the comment in the same change.

## HTTP

- Send every request through `http()`, using `gh(path)` or `discord(path)`. `http()` gives
  one retry on 429 and 5xx, a truncated error body, and `err.status`. For a full URL, such as
  a pagination link, call `http()` with the same headers as `gh()`. `fetchReviews` shows how.
- A failed request throws `Error("<METHOD> <url> failed: <status> <body>")` with `err.status`
  set. Catch only the outcome you expect, test it by `err.status`, and rethrow the rest (see
  `ensureLabel`: 422 `already_exists`; `release`: 404). Uncaught errors reach
  `main().catch`, which exits 1 and fails the consumer's job. That failure is what tells
  them something went wrong.
- Follow a `Link: rel="next"` URL only when its host is `api.github.com`, so the token never
  leaves GitHub.

## Discord

- Every message body sets `allowed_mentions: { parse: [] }` and adds only the mapped user
  snowflakes to `users`. This hard guardrail is the only thing that keeps `@everyone`,
  `@here` and role pings out of a PR title or body.
- Before any PATCH to an archived thread, unarchive it (error 50083). Archive only a thread
  that isn't archived yet.
- Thread names are at most 100 characters. Build them with `threadName()`.
- Forum tags are matched by exact name against `TAG_NAMES`. A new tag means updating
  `TAG_NAMES`, `STATUS_LINES`, the README setup list and the tests' `TAG_IDS`.

## Sync logic

- Treat the freshly fetched PR (`current` in `main()`) as the truth. The event payload can
  be stale, because runs are queued per PR.
- Order side effects so a failure leaves state a retry can finish. Writes that can fail on
  token permissions (`mapping.prepare()`) go before Discord is touched. `mapping.release()`
  stays the last step.
- Label names, prefixes and validation stay inside `threadMapping`. Callers use only `find`,
  `prepare`, `save` and `release`.
- Skip a PR when its head repo can't be shown to match `GITHUB_REPOSITORY`. Fork PRs must
  never run with the consumer's secrets.

## Logging

- Every early return logs a one-line reason with `console.log`. Tests assert on these lines.
- Config that is degraded but usable (a bad user map entry) gets `console.warn`, and the run
  carries on.
- Log URLs, IDs and request bodies, never tokens.

## Action and workflows

- Pin every `uses:` to a full commit SHA with a `# vX.Y.Z` comment. Dependabot keeps both
  current.
- Give each workflow least-privilege `permissions:`.
- Action input names are kebab-case and map to SCREAMING_SNAKE env vars in `action.yml`.
  Env var and repo variable names avoid the reserved `GITHUB_` prefix (GitHub drops them;
  see commit 3f2d3e0).

## Tests

- `test/sync-pr.test.mjs` runs the script end to end: it spawns it with `--dry-run` against
  an event in `fixtures/` and asserts on exit code and stdout. Dry-run prints
  `[dry-run] <METHOD> <url>` and the JSON body for every write. Assert on those lines, for
  example `/"applied_tags":\["6"\]/`.
- Every behaviour change gets a test, named `"<situation>: <expected outcome>"`.
- For a variant of an existing event, use `runMutatedFixture` to change it in the test. Add a
  file to `fixtures/` only for a new event type or action (`<action>[_<variant>].json`, repo
  `KZ-OWNER/test-repo`, PR 42).
- Writes are stubbed by dry-run automatically. A new network read needs its own stub in
  `http()` or a `DRY_RUN` branch, driven by a `DRY_RUN_<NAME>` env var. Document it where
  it's defined and in the test file's header comment. Without a stub, the test hits the
  network.
- When the PR's state differs from the event, pass the fresh PR through
  `DRY_RUN_FRESH_PR_JSON` and keep the event as it is. That is how stale payloads are
  tested.
