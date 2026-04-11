# github-discord-pr-sync

Mirror GitHub pull requests into a Discord forum channel as threads, with forum tags that
reflect the PR's lifecycle (`Draft`, `Open`, `Changes Requested`, `Re-review Requested`,
`Approved`, `Merged`, `Closed`).

- **No infrastructure.** Runs as a GitHub Actions composite action.
- **No dependencies.** A single ~400-line Node 20 script using built-in `fetch`.
- **No external storage.** PR ↔ thread mapping lives in a `discord-thread:<id>` PR label.
- **Cross-org.** This repo is public so any repo (yours or a colleague's) can use the
  action.

## How it works

```
GitHub PR event ──▶ caller workflow in consumer repo
                       │
                       ▼
               uses: kamilZ01/github-discord-pr-sync@v1
               (composite action — this repo)
                       │
                       ▼
               scripts/sync-pr.mjs
                       │
                       ├── creates a forum thread (first event for a PR)
                       │   then writes `discord-thread:<id>` label on the PR
                       │
                       └── on later events, finds the thread via the label,
                           PATCHes its forum tags, and posts a status line
```

GitHub resolves `github.action_path` to this action's files at the pinned ref —
no checkout of this repo is needed in the consumer workflow.

## One-time setup

### 1. Discord

1. Create a Discord application + bot at <https://discord.com/developers/applications>.
2. Invite the bot to your server with the `bot` scope and these channel permissions:
   - View Channels
   - Send Messages in Threads
   - Create Public Threads
   - Manage Threads (required to PATCH `applied_tags`)
3. For each repo you want to sync, create a **forum channel** (e.g. `#api-server-prs`).
4. In each forum channel, create these 7 tags **with these exact names** (the script
   matches by name):
   - `Draft`
   - `Open`
   - `Changes Requested`
   - `Re-review Requested`
   - `Approved`
   - `Merged`
   - `Closed`
5. Enable Developer Mode in Discord, right-click each forum channel → **Copy Channel ID**.

### 2. Each consumer repo

Add to repo settings:

| Kind | Name | Value |
|---|---|---|
| Secret | `DISCORD_BOT_TOKEN` | The bot token from the Discord developer portal |
| Variable | `DISCORD_FORUM_CHANNEL_ID` | The forum channel ID for this repo |
| Variable (optional) | `DISCORD_TAG_IDS_JSON` | Filled in automatically — see step 3 |
| Variable (optional) | `GITHUB_TO_DISCORD_USER_MAP` | JSON map to @-mention reviewers and authors — see step 4 |

Then drop this caller workflow into the repo at
`.github/workflows/discord-pr-sync.yml`:

```yaml
name: Discord PR Sync
on:
  pull_request:
    types:
      - opened
      - reopened
      - edited
      - closed
      - ready_for_review
      - converted_to_draft
      - review_requested
      - review_request_removed
  pull_request_review:
    types: [submitted, dismissed]

jobs:
  sync:
    # Skip PRs from forks — they don't have access to secrets.
    if: >-
      github.event.pull_request != null &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    concurrency:
      group: discord-pr-sync-${{ github.event.pull_request.number }}
      cancel-in-progress: false
    steps:
      - uses: kamilZ01/github-discord-pr-sync@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          discord-bot-token: ${{ secrets.DISCORD_BOT_TOKEN }}
          discord-forum-channel-id: ${{ vars.DISCORD_FORUM_CHANNEL_ID }}
          discord-tag-ids-json: ${{ vars.DISCORD_TAG_IDS_JSON }}
          github-to-discord-user-map: ${{ vars.GITHUB_TO_DISCORD_USER_MAP }}
```

> **Pinning:** For supply-chain hardening, pin `@v1` to a full commit SHA
> (e.g. `@abc123def...`). A mutable tag like `@v1` tracks the latest patch
> in that major version; a SHA is immutable.

### 3. First run caches tag IDs

The first time the script runs in a repo it queries Discord for the forum's tags by name
and prints a JSON line like:

```
Resolved Discord tag ids. Cache them by setting repo variable DISCORD_TAG_IDS_JSON to:
{"Draft":"123...","Open":"456...", ...}
```

Copy that JSON into a repo variable named `DISCORD_TAG_IDS_JSON`. Subsequent runs skip
the lookup, saving one Discord API call per event.

### 4. Optional: real Discord @-mentions for reviewers

By default, `@login` strings in the thread are plain text (no ping). To make the action
actually notify Discord users when a review is requested or a review is submitted, set
the `GITHUB_TO_DISCORD_USER_MAP` repo variable to a JSON object mapping each teammate's
GitHub login to their Discord **user ID** (snowflake):

```json
{"alice":"123456789012345678","bob":"234567890123456789"}
```

To get a Discord user ID, enable Developer Mode in Discord → right-click a user → **Copy
User ID**. Once configured, the action posts real pings:

- `pull_request.review_requested` → pings the requested reviewer
- `pull_request_review.submitted` (approve / changes requested) → pings the PR author

Only the explicit user IDs in this map are allowed to ping; `@everyone`, `@here`, and
role mentions are always suppressed. Unmapped logins fall back to plain-text `@login`.

## Local dry-run

You can test the script without touching Discord:

```bash
GITHUB_EVENT_PATH=fixtures/opened.json \
GITHUB_EVENT_NAME=pull_request \
GITHUB_REPOSITORY=KZ-OWNER/test-repo \
GITHUB_TOKEN=ghp_dummy \
DISCORD_BOT_TOKEN=dummy \
DISCORD_FORUM_CHANNEL_ID=000 \
DISCORD_TAG_IDS_JSON='{"Draft":"1","Open":"2","Changes Requested":"3","Re-review Requested":"4","Approved":"5","Merged":"6","Closed":"7"}' \
node scripts/sync-pr.mjs --dry-run
```

`--dry-run` logs the would-be Discord writes instead of sending them. The PR-reviews
GET (`/pulls/:n/reviews`) is also stubbed to return `[]` so `review_requested` and
similar branches don't need network access. Set `DISCORD_TAG_IDS_JSON` (as shown above)
to skip the Discord channel fetch — otherwise the script will still call Discord to
resolve tag IDs, since that GET is not stubbed.

## Tests

```bash
node --test test/sync-pr.test.mjs
```

## End-to-end verification checklist

In one test repo, after wiring the caller workflow:

- [ ] Open a draft PR → thread appears tagged `Draft`, label `discord-thread:<id>` is on the PR.
- [ ] Mark ready for review → tag reflects aggregate review state (e.g. `Open` if no reviews, `Changes Requested` if blocking reviews persist from draft).
- [ ] Request a reviewer (no prior reviews) → tag stays `Open`.
- [ ] Submit a `Request changes` review → tag flips to `Changes Requested`.
- [ ] Re-request the same reviewer → tag flips to `Re-review Requested`.
- [ ] Submit an `Approve` review → tag reflects aggregate state (`Approved` if no other reviewer has outstanding changes requested).
- [ ] Edit the PR title → thread name updates.
- [ ] Merge the PR → tag flips to `Merged`, thread stays active.

> **Note:** In multi-reviewer scenarios the tag reflects the aggregate review
> state, not just the latest individual review. For example, if reviewer A
> approves but reviewer B still has changes requested, the tag stays
> `Changes Requested`.

## Caveats

- The bot needs **Manage Threads**. Without it, thread creation works but tag updates fail.
- If someone manually deletes the `discord-thread:<id>` label, the next event creates a
  duplicate thread.
- Discord forum tag names are matched **case-sensitively** — they must be exact.
- PRs from forks are skipped (no access to secrets). Bot reviews are ignored, but PRs
  opened by bots (e.g. Dependabot) still get threads.
- Pushed commits do **not** post in the thread; only review/state events do.
- Each sync event sets **exactly one** lifecycle forum tag on the thread. Any other
  forum tags manually added to the thread will be removed on the next update.

## License

MIT
