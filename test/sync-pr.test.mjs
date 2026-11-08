// End-to-end tests for scripts/sync-pr.mjs.
// Zero dependencies. Run with: node --test test/sync-pr.test.mjs
//
// Strategy: spawn the script as a subprocess in --dry-run mode against
// fixture event payloads and assert on stdout/stderr/exit-code. Dry-run
// short-circuits non-GET HTTP requests and also stubs the PR-reviews GET
// (needed by the review_requested path). DISCORD_TAG_IDS_JSON is set so
// resolveTagIds skips the Discord channel fetch. The Discord /channels/:id
// GET used by getThread is not called under dry-run — tests can instead set
// DRY_RUN_CURRENT_TAG_ID to simulate a thread that already has a given tag,
// DRY_RUN_CURRENT_THREAD_NAME to simulate the current thread name (defaults
// to the computed new name when unset, so existing tests are unaffected), and
// DRY_RUN_CURRENT_ARCHIVED to simulate an archived thread (defaults to false).
// These hooks only apply to an existing thread: a thread the run just created
// has its state built from what was sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const SCRIPT = join(repoRoot, "scripts", "sync-pr.mjs");
const FIXTURES = join(repoRoot, "fixtures");

const TAG_IDS = JSON.stringify({
  Draft: "1",
  Open: "2",
  "Changes Requested": "3",
  "Re-review Requested": "4",
  Approved: "5",
  Merged: "6",
  Closed: "7",
});

const baseEnv = {
  PATH: process.env.PATH,
  GITHUB_TOKEN: "fake",
  GITHUB_REPOSITORY: "KZ-OWNER/test-repo",
  DISCORD_BOT_TOKEN: "fake",
  DISCORD_FORUM_CHANNEL_ID: "1234",
  DISCORD_TAG_IDS_JSON: TAG_IDS,
};

function run({ env = {}, args = ["--dry-run"] } = {}) {
  const result = spawnSync("node", [SCRIPT, ...args], {
    env: { ...baseEnv, ...env },
    encoding: "utf8",
  });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runFixture(fixture, eventName, extraEnv = {}) {
  return run({
    env: {
      GITHUB_EVENT_PATH: join(FIXTURES, fixture),
      GITHUB_EVENT_NAME: eventName,
      ...extraEnv,
    },
  });
}

// ---------- Env validation ----------

test("env validation: missing all required vars exits with error listing all", () => {
  const r = spawnSync("node", [SCRIPT], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing required env vars/);
  for (const v of [
    "GITHUB_EVENT_PATH",
    "GITHUB_EVENT_NAME",
    "GITHUB_TOKEN",
    "DISCORD_BOT_TOKEN",
    "DISCORD_FORUM_CHANNEL_ID",
  ]) {
    assert.match(r.stderr, new RegExp(v));
  }
});

test("env validation: only some vars set lists only the missing ones", () => {
  const r = spawnSync("node", [SCRIPT], {
    env: {
      PATH: process.env.PATH,
      GITHUB_EVENT_PATH: "/tmp/x",
      GITHUB_TOKEN: "fake",
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing required env vars/);
  assert.match(r.stderr, /GITHUB_EVENT_NAME/);
  assert.match(r.stderr, /DISCORD_BOT_TOKEN/);
  assert.match(r.stderr, /DISCORD_FORUM_CHANNEL_ID/);
  assert.doesNotMatch(r.stderr, /GITHUB_EVENT_PATH/);
  assert.doesNotMatch(r.stderr, /GITHUB_TOKEN[^_]/);
});

// ---------- Happy paths ----------

test("opened PR: creates new thread with Open tag and writes mapping label", () => {
  const r = runFixture("opened.json", "pull_request");
  assert.equal(r.code, 0, r.stderr);
  // Forum thread created
  assert.match(r.stdout, /POST https:\/\/discord\.com\/api\/v10\/channels\/1234\/threads/);
  // Open tag id (2) applied
  assert.match(r.stdout, /"applied_tags":\["2"\]/);
  // Discord-managed label ensured
  assert.match(r.stdout, /"name":"discord-managed"/);
  // Thread mapping label created and applied
  assert.match(r.stdout, /"name":"discord-thread:DRY_RUN_THREAD_ID"/);
  assert.match(r.stdout, /\/issues\/42\/labels/);
  assert.match(r.stdout, /Created thread DRY_RUN_THREAD_ID with tag Open/);
  // Reviewers are pinged by their own review_requested run, never here.
  assert.doesNotMatch(r.stdout, /DRY_RUN_THREAD_ID\/messages/);
  // Without a user map, author renders as plain text and no users are pinged.
  assert.match(r.stdout, /by @kz/);
  assert.match(r.stdout, /"allowed_mentions":\{"parse":\[\]\}/);
});

test("opened PR: ensures discord-managed label before creating the thread", () => {
  // A token that can't write labels must fail before a Discord thread exists,
  // or every retry leaves another orphan thread behind.
  const r = runFixture("opened.json", "pull_request");
  assert.equal(r.code, 0, r.stderr);
  const labelIdx = r.stdout.indexOf('"name":"discord-managed"');
  const threadIdx = r.stdout.indexOf("POST https://discord.com/api/v10/channels/1234/threads");
  assert.ok(labelIdx > -1 && threadIdx > -1, r.stdout);
  assert.ok(labelIdx < threadIdx, "discord-managed must be ensured before the thread is created");
});

test("opened PR with author in user map: pings author in initial post", () => {
  const r = runFixture("opened.json", "pull_request", {
    DISCORD_USER_MAP_JSON: JSON.stringify({ kz: "666666666666666666" }),
  });
  assert.equal(r.code, 0, r.stderr);
  // Initial post renders the Discord mention instead of plain @login.
  assert.match(r.stdout, /by <@666666666666666666>/);
  // allowed_mentions.users includes the author ID so the ping actually fires.
  assert.match(r.stdout, /"allowed_mentions":\{"parse":\[\],"users":\["666666666666666666"\]\}/);
  // Plain "@kz" must NOT appear in the content.
  assert.doesNotMatch(r.stdout, /by @kz/);
});

test("opened PR with author not in user map: plain-text author, no ping", () => {
  const r = runFixture("opened.json", "pull_request", {
    DISCORD_USER_MAP_JSON: JSON.stringify({ alice: "111111111111111111" }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /by @kz/);
  assert.match(r.stdout, /"allowed_mentions":\{"parse":\[\]\}/);
  assert.doesNotMatch(r.stdout, /"users":\[/);
});

test("closed+merged PR: updates existing thread to Merged tag and prefixed name", () => {
  const r = runFixture("closed_merged.json", "pull_request", {
    DRY_RUN_CURRENT_THREAD_NAME: "#42 Add retry logic to token refresh",
  });
  assert.equal(r.code, 0, r.stderr);
  // PATCH to existing thread id from label
  assert.match(r.stdout, /PATCH https:\/\/discord\.com\/api\/v10\/channels\/1234567890/);
  // Merged tag id (6) and prefixed name in a single PATCH
  assert.match(r.stdout, /"applied_tags":\["6"\]/);
  assert.match(r.stdout, /"name":"🟣 #42 Add retry logic to token refresh"/);
  // Status message posted
  assert.match(r.stdout, /🟣 Merged by @kz/);
  assert.match(r.stdout, /Updated thread 1234567890 → Merged/);
  // Status message includes allowed_mentions to suppress pings
  assert.match(r.stdout, /allowed_mentions/);
});

test("review submitted (changes_requested): updates thread to Changes Requested tag", () => {
  const r = runFixture("review_changes_requested.json", "pull_request_review");
  assert.equal(r.code, 0, r.stderr);
  // Changes Requested tag id (3) applied
  assert.match(r.stdout, /"applied_tags":\["3"\]/);
  assert.match(r.stdout, /🛠️ Changes requested by @bob/);
  assert.match(r.stdout, /Updated thread 1234567890 → Changes Requested/);
});

// ---------- Mentions ----------

test("review_requested with user map: posts Discord mention with allowed_mentions.users", () => {
  const r = runFixture("review_requested.json", "pull_request", {
    DISCORD_USER_MAP_JSON: JSON.stringify({ alice: "111111111111111111" }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /<@111111111111111111>/);
  assert.match(r.stdout, /"allowed_mentions":\{"parse":\[\],"users":\["111111111111111111"\]\}/);
  assert.match(r.stdout, /review requested from <@111111111111111111>/);
});

test("review_requested without user map: plain text, no ping", () => {
  const r = runFixture("review_requested.json", "pull_request");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /review requested from @alice/);
  // No user IDs in allowed_mentions
  assert.doesNotMatch(r.stdout, /"users":\[/);
  assert.match(r.stdout, /"allowed_mentions":\{"parse":\[\]\}/);
});

test("review_requested with map missing this reviewer: plain text fallback", () => {
  const r = runFixture("review_requested.json", "pull_request", {
    DISCORD_USER_MAP_JSON: JSON.stringify({ bob: "222222222222222222" }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /review requested from @alice/);
  assert.doesNotMatch(r.stdout, /"users":\[/);
});

test("review submitted: pings PR author when mapped", () => {
  const r = runFixture("review_changes_requested.json", "pull_request_review", {
    DISCORD_USER_MAP_JSON: JSON.stringify({ kz: "333333333333333333" }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /🛠️ Changes requested by @bob — cc <@333333333333333333>/);
  assert.match(r.stdout, /"allowed_mentions":\{"parse":\[\],"users":\["333333333333333333"\]\}/);
});

test("review submitted: no cc when author has no mapping", () => {
  const r = runFixture("review_changes_requested.json", "pull_request_review", {
    DISCORD_USER_MAP_JSON: JSON.stringify({ bob: "444444444444444444" }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /🛠️ Changes requested by @bob/);
  assert.doesNotMatch(r.stdout, / — cc </);
  assert.doesNotMatch(r.stdout, /"users":\[/);
});

test("invalid Discord IDs in user map are dropped with a warning", () => {
  const r = runFixture("review_requested.json", "pull_request", {
    DISCORD_USER_MAP_JSON: JSON.stringify({ alice: "not-a-snowflake" }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /dropping "alice"/);
  assert.match(r.stdout, /review requested from @alice/);
  assert.doesNotMatch(r.stdout, /"users":\[/);
});

test("malformed DISCORD_USER_MAP_JSON: warns and disables mentions", () => {
  const r = runFixture("review_requested.json", "pull_request", {
    DISCORD_USER_MAP_JSON: "{not json",
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /not valid JSON/);
  assert.match(r.stdout, /review requested from @alice/);
  assert.doesNotMatch(r.stdout, /"users":\[/);
});

test("review_requested with tag already Open: posts 🔔 mention without tag update", () => {
  // DRY_RUN_CURRENT_TAG_ID=2 simulates an existing thread that's already
  // tagged Open, so main() takes the tag-unchanged branch of the status flow.
  const r = runFixture("review_requested.json", "pull_request", {
    DISCORD_USER_MAP_JSON: JSON.stringify({ alice: "111111111111111111" }),
    DRY_RUN_CURRENT_TAG_ID: "2",
  });
  assert.equal(r.code, 0, r.stderr);
  // Tag-change PATCH must NOT fire.
  assert.doesNotMatch(r.stdout, /"applied_tags":/);
  // 🔔 branch posted with real ping.
  assert.match(r.stdout, /🔔 Review requested from <@111111111111111111>/);
  assert.match(r.stdout, /"allowed_mentions":\{"parse":\[\],"users":\["111111111111111111"\]\}/);
});

test("review_requested before any thread exists: creates the thread, then pings the reviewer", () => {
  // CODEOWNERS requests reviewers as the PR opens, so the review_requested run
  // can start before the opened run. The opened run then finds the tag already
  // Open and posts nothing, so this run is the reviewer's only ping.
  const r = runMutatedFixture(
    "review_requested.json",
    "pull_request",
    (e) => {
      e.pull_request.labels = [];
    },
    { DISCORD_USER_MAP_JSON: JSON.stringify({ alice: "111111111111111111" }) },
  );
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /POST https:\/\/discord\.com\/api\/v10\/channels\/1234\/threads/);
  assert.match(r.stdout, /"name":"discord-thread:DRY_RUN_THREAD_ID"/);
  assert.match(
    r.stdout,
    /POST https:\/\/discord\.com\/api\/v10\/channels\/DRY_RUN_THREAD_ID\/messages/,
  );
  assert.match(r.stdout, /🔔 Review requested from <@111111111111111111>/);
  assert.match(r.stdout, /"allowed_mentions":\{"parse":\[\],"users":\["111111111111111111"\]\}/);
});

test("review submitted: self-review (author === reviewer) does not cc author", () => {
  const base = JSON.parse(readFileSync(join(FIXTURES, "review_changes_requested.json"), "utf8"));
  // Author reviewing their own PR — bob becomes both reviewer and PR author.
  base.review.user.login = "bob";
  base.sender.login = "bob";
  base.pull_request.user.login = "bob";

  const dir = mkdtempSync(join(tmpdir(), "sync-pr-test-"));
  const fixturePath = join(dir, "self-review.json");
  writeFileSync(fixturePath, JSON.stringify(base), "utf8");

  const r = run({
    env: {
      GITHUB_EVENT_PATH: fixturePath,
      GITHUB_EVENT_NAME: "pull_request_review",
      DISCORD_USER_MAP_JSON: JSON.stringify({ bob: "555555555555555555" }),
    },
  });

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /🛠️ Changes requested by @bob/);
  assert.doesNotMatch(r.stdout, / — cc </);
  assert.doesNotMatch(r.stdout, /"users":\[/);
});

test("review_requested for a team: uses team name as plain text, no ping", () => {
  const base = JSON.parse(readFileSync(join(FIXTURES, "review_requested.json"), "utf8"));
  delete base.requested_reviewer;
  base.requested_team = { name: "Platform", slug: "platform" };

  const dir = mkdtempSync(join(tmpdir(), "sync-pr-test-"));
  const fixturePath = join(dir, "team-review-requested.json");
  writeFileSync(fixturePath, JSON.stringify(base), "utf8");

  const r = run({
    env: {
      GITHUB_EVENT_PATH: fixturePath,
      GITHUB_EVENT_NAME: "pull_request",
      DISCORD_USER_MAP_JSON: JSON.stringify({ alice: "111111111111111111" }),
    },
  });

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /review requested from team `Platform`/);
  assert.doesNotMatch(r.stdout, /"users":\[/);
});

// ---------- Edit handling ----------

test("PR edited with title change: renames thread, no tag update", () => {
  const r = runFixture("edited_title.json", "pull_request");
  assert.equal(r.code, 0, r.stderr);
  // PATCH with new name
  assert.match(r.stdout, /PATCH https:\/\/discord\.com\/api\/v10\/channels\/1234567890/);
  assert.match(r.stdout, /"name":"#42 Add retry logic to token refresh \(v2\)"/);
  assert.match(r.stdout, /Renamed thread 1234567890/);
  // Should NOT touch tags
  assert.doesNotMatch(r.stdout, /applied_tags/);
});

test("PR edited without title change: no-op", () => {
  const r = runFixture("edited_body_only.json", "pull_request");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Edit event with no title change; nothing to do/);
  assert.doesNotMatch(r.stdout, /PATCH/);
  assert.doesNotMatch(r.stdout, /POST/);
});

// ---------- Defensive paths ----------

test("fork PR (head repo != GITHUB_REPOSITORY): skipped", () => {
  const r = runFixture("opened.json", "pull_request", {
    GITHUB_REPOSITORY: "someone-else/test-repo",
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Fork PR; skipping/);
  assert.doesNotMatch(r.stdout, /POST/);
});

test("multiple discord-thread labels: warns and uses first match", () => {
  const base = JSON.parse(readFileSync(join(FIXTURES, "closed_merged.json"), "utf8"));
  base.pull_request.labels = [
    { name: "discord-thread:1234567890" },
    { name: "discord-thread:9999999999" },
  ];

  const dir = mkdtempSync(join(tmpdir(), "sync-pr-test-"));
  const fixturePath = join(dir, "duplicate-labels.json");
  writeFileSync(fixturePath, JSON.stringify(base), "utf8");

  const r = run({
    env: {
      GITHUB_EVENT_PATH: fixturePath,
      GITHUB_EVENT_NAME: "pull_request",
    },
  });

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /Multiple discord-thread: labels found/);
  // Uses first label (1234567890), not second
  assert.match(r.stdout, /1234567890/);
});

test("PR with null head.repo: skipped as unknown origin", () => {
  const base = JSON.parse(readFileSync(join(FIXTURES, "opened.json"), "utf8"));
  base.pull_request.head.repo = null;

  const dir = mkdtempSync(join(tmpdir(), "sync-pr-test-"));
  const fixturePath = join(dir, "null-head-repo.json");
  writeFileSync(fixturePath, JSON.stringify(base), "utf8");

  const r = run({
    env: {
      GITHUB_EVENT_PATH: fixturePath,
      GITHUB_EVENT_NAME: "pull_request",
    },
  });

  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /PR head repo unknown/);
  assert.doesNotMatch(r.stdout, /POST/);
});

test("invalid discord-thread label id: exits safely before Discord writes", () => {
  const base = JSON.parse(readFileSync(join(FIXTURES, "closed_merged.json"), "utf8"));
  base.pull_request.labels = [{ name: "discord-thread:not-a-snowflake" }];

  const dir = mkdtempSync(join(tmpdir(), "sync-pr-test-"));
  const fixturePath = join(dir, "invalid-thread-label.json");
  writeFileSync(fixturePath, JSON.stringify(base), "utf8");

  const r = run({
    env: {
      GITHUB_EVENT_PATH: fixturePath,
      GITHUB_EVENT_NAME: "pull_request",
    },
  });

  assert.equal(r.code, 1);
  assert.match(r.stderr, /Invalid Discord thread id in label/);
  assert.doesNotMatch(r.stdout, /PATCH/);
  assert.doesNotMatch(r.stdout, /POST/);
});

// ---------- Thread name prefixes ----------

test("closed without merge: updates thread to Closed tag and 🔴 prefixed name", () => {
  const r = runFixture("closed_not_merged.json", "pull_request", {
    DRY_RUN_CURRENT_THREAD_NAME: "#42 Add retry logic to token refresh",
    DRY_RUN_CURRENT_TAG_ID: "2", // was Open
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"applied_tags":\["7"\]/);
  assert.match(r.stdout, /"name":"🔴 #42 Add retry logic to token refresh"/);
  assert.match(r.stdout, /🔴 Closed without merging by @kz/);
  assert.match(r.stdout, /Updated thread 1234567890 → Closed/);
});

// Title edits on a closed PR take the full sync, not a bare rename (main() in
// scripts/sync-pr.mjs skips the edit branch when the PR is closed), so these
// stub the thread as already Merged under its old name.
const MERGED_THREAD_BEFORE_RENAME = {
  DRY_RUN_CURRENT_TAG_ID: "6",
  DRY_RUN_CURRENT_THREAD_NAME: "🟣 #42 Add retry logic",
};

test("title edit on merged PR: thread name includes 🟣 prefix", () => {
  const r = runFixture("edited_title_merged.json", "pull_request", MERGED_THREAD_BEFORE_RENAME);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /PATCH https:\/\/discord\.com\/api\/v10\/channels\/1234567890/);
  assert.match(r.stdout, /"name":"🟣 #42 Add retry logic to token refresh \(v2\)"/);
  assert.match(r.stdout, /Updated thread 1234567890 name/);
  assert.doesNotMatch(r.stdout, /applied_tags/);
});

test("title edit on open PR: thread name has no prefix", () => {
  const r = runFixture("edited_title.json", "pull_request");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"name":"#42 Add retry logic to token refresh \(v2\)"/);
  assert.doesNotMatch(r.stdout, /🟣/);
  assert.doesNotMatch(r.stdout, /🔴/);
});

test("name-only update (tag already correct): patches name without status message, archives", () => {
  const r = runFixture("closed_merged.json", "pull_request", {
    DRY_RUN_CURRENT_TAG_ID: "6", // already Merged
    DRY_RUN_CURRENT_THREAD_NAME: "#42 Add retry logic to token refresh", // legacy unprefixed
  });
  assert.equal(r.code, 0, r.stderr);
  // Name-only PATCH (no applied_tags)
  assert.match(r.stdout, /"name":"🟣 #42 Add retry logic to token refresh"/);
  assert.doesNotMatch(r.stdout, /applied_tags/);
  // No status message posted — only name updated
  assert.match(r.stdout, /Updated thread 1234567890 name/);
  assert.doesNotMatch(r.stdout, /🟣 Merged by/);
  // Thread is archived (terminal state)
  assert.match(r.stdout, /"archived":true/);
});

// ---------- Bug fixes ----------

test("ready_for_review with prior changes_requested review: message says 'ready for review', not 'changes requested'", () => {
  const reviews = [
    { user: { login: "bob", type: "User" }, state: "CHANGES_REQUESTED", submitted_at: "2026-04-12T10:00:00Z" },
  ];
  const r = runFixture("ready_for_review.json", "pull_request", {
    DRY_RUN_CURRENT_TAG_ID: "1", // was Draft
    DRY_RUN_REVIEWS_JSON: JSON.stringify(reviews),
  });
  assert.equal(r.code, 0, r.stderr);
  // Tag updates to Changes Requested (correct — reflects actual review state)
  assert.match(r.stdout, /"applied_tags":\["3"\]/);
  // Message reports the action, not the recomputed state
  assert.match(r.stdout, /🟢 Marked as ready for review by @kz/);
  assert.doesNotMatch(r.stdout, /🛠️ Changes requested/);
});

test("ready_for_review with no prior reviews: message says 'ready for review', tag Open", () => {
  const r = runFixture("ready_for_review.json", "pull_request", {
    DRY_RUN_CURRENT_TAG_ID: "1", // was Draft
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"applied_tags":\["2"\]/); // Open
  assert.match(r.stdout, /🟢 Marked as ready for review by @kz/);
});

test("ready_for_review with tag already matching recomputed state: still posts status line", () => {
  // Edge case: tag is already "Changes Requested" (e.g. Discord/GitHub out of sync),
  // so tagChanged is false — but the undraft action should still produce a message.
  const reviews = [
    { user: { login: "bob", type: "User" }, state: "CHANGES_REQUESTED", submitted_at: "2026-04-12T10:00:00Z" },
  ];
  const r = runFixture("ready_for_review.json", "pull_request", {
    DRY_RUN_CURRENT_TAG_ID: "3", // already Changes Requested
    DRY_RUN_REVIEWS_JSON: JSON.stringify(reviews),
  });
  assert.equal(r.code, 0, r.stderr);
  // No tag PATCH needed
  assert.doesNotMatch(r.stdout, /"applied_tags":/);
  // Status line still posted
  assert.match(r.stdout, /🟢 Marked as ready for review by @kz/);
});

test("ready_for_review before any thread exists: creates the thread, then posts the status line", () => {
  // A new thread takes the same status-line rule as an existing one.
  const r = runMutatedFixture("ready_for_review.json", "pull_request", (e) => {
    e.pull_request.labels = [];
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /POST https:\/\/discord\.com\/api\/v10\/channels\/1234\/threads/);
  assert.match(r.stdout, /Created thread DRY_RUN_THREAD_ID with tag Open/);
  // The new thread already has the tag and name: no PATCH.
  assert.doesNotMatch(r.stdout, /PATCH/);
  assert.match(
    r.stdout,
    /POST https:\/\/discord\.com\/api\/v10\/channels\/DRY_RUN_THREAD_ID\/messages/,
  );
  assert.match(r.stdout, /🟢 Marked as ready for review by @kz/);
});

test("fetchReviews paginates: follows Link: rel=next to fetch every page", () => {
  // Page 1 (full 100) is all APPROVED. Page 2 has a later CHANGES_REQUESTED
  // review. If pagination works, state resolves to Changes Requested. If the
  // old single-page code were still in place, it would either throw on the
  // 100-item limit or miss page 2 entirely — either way, not Changes Requested.
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    user: { login: `u${i}`, type: "User" },
    state: "APPROVED",
    submitted_at: "2026-04-01T10:00:00Z",
  }));
  const page2 = [
    {
      user: { login: "blocker", type: "User" },
      state: "CHANGES_REQUESTED",
      submitted_at: "2026-04-15T10:00:00Z",
    },
  ];
  const r = runFixture("ready_for_review.json", "pull_request", {
    DRY_RUN_CURRENT_TAG_ID: "1", // was Draft
    DRY_RUN_REVIEWS_PAGES_JSON: JSON.stringify([page1, page2]),
  });
  assert.equal(r.code, 0, r.stderr);
  // Both pages were fetched.
  assert.match(r.stdout, /\[dry-run\] GET https:\/\/api\.github\.com\/repos\/[^ ]+\/reviews\?per_page=100\n/);
  assert.match(r.stdout, /\[dry-run\] GET https:\/\/api\.github\.com\/repos\/[^ ]+\/reviews\?per_page=100&page=2\n/);
  // Recomputed state reflects page 2's CHANGES_REQUESTED review.
  assert.match(r.stdout, /"applied_tags":\["3"\]/);
});

test("stale payload labels: fresh refetch finds thread label, skips creation", () => {
  // Simulate: payload has no labels (stale), but API refetch finds the thread label
  const freshPr = { labels: [{ name: "discord-thread:9876543210" }] };
  const r = runFixture("opened.json", "pull_request", {
    DRY_RUN_FRESH_PR_JSON: JSON.stringify(freshPr),
  });
  assert.equal(r.code, 0, r.stderr);
  // Should NOT create a new thread
  assert.doesNotMatch(r.stdout, /POST https:\/\/discord\.com\/api\/v10\/channels\/1234\/threads/);
  // Should update the existing thread found via refetch
  assert.match(r.stdout, /PATCH https:\/\/discord\.com\/api\/v10\/channels\/9876543210/);
});

test("stale payload labels: fresh refetch finds no label, creates thread normally", () => {
  // No DRY_RUN_FRESH_PR_JSON set — the stub returns the event's own
  // pull_request, which in opened.json has no labels.
  const r = runFixture("opened.json", "pull_request");
  assert.equal(r.code, 0, r.stderr);
  // Thread creation proceeds as before
  assert.match(r.stdout, /POST https:\/\/discord\.com\/api\/v10\/channels\/1234\/threads/);
  assert.match(r.stdout, /Created thread DRY_RUN_THREAD_ID with tag Open/);
});

// ---------- Thread archiving ----------

test("closed+merged: thread is archived after status message", () => {
  const r = runFixture("closed_merged.json", "pull_request", {
    DRY_RUN_CURRENT_THREAD_NAME: "#42 Add retry logic to token refresh",
  });
  assert.equal(r.code, 0, r.stderr);
  // Status message POST must appear before the archive PATCH
  const postIdx = r.stdout.indexOf("POST https://discord.com/api/v10/channels/1234567890/messages");
  const archiveIdx = r.stdout.indexOf('"archived":true');
  assert.ok(postIdx > -1, "status message should be posted");
  assert.ok(archiveIdx > -1, "thread should be archived");
  assert.ok(archiveIdx > postIdx, "archive PATCH must come after status message POST");
});

test("merged + name-only (tag already correct): archives even without status message", () => {
  const r = runFixture("closed_merged.json", "pull_request", {
    DRY_RUN_CURRENT_TAG_ID: "6", // already Merged
    DRY_RUN_CURRENT_THREAD_NAME: "#42 Add retry logic to token refresh", // legacy unprefixed
  });
  assert.equal(r.code, 0, r.stderr);
  // Name-only PATCH (no applied_tags)
  assert.match(r.stdout, /"name":"🟣 #42 Add retry logic to token refresh"/);
  assert.doesNotMatch(r.stdout, /applied_tags/);
  // No status message posted
  assert.doesNotMatch(r.stdout, /🟣 Merged by/);
  // But thread IS archived
  assert.match(r.stdout, /"archived":true/);
});

test("closed without merge: thread is archived", () => {
  const r = runFixture("closed_not_merged.json", "pull_request", {
    DRY_RUN_CURRENT_THREAD_NAME: "#42 Add retry logic to token refresh",
    DRY_RUN_CURRENT_TAG_ID: "2", // was Open
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"archived":true/);
  // Archive comes after status message
  const postIdx = r.stdout.indexOf("POST https://discord.com/api/v10/channels/1234567890/messages");
  const archiveIdx = r.stdout.indexOf('"archived":true');
  assert.ok(archiveIdx > postIdx, "archive must come after status message");
});

test("title edit on merged PR: renames, then archives", () => {
  const r = runFixture("edited_title_merged.json", "pull_request", MERGED_THREAD_BEFORE_RENAME);
  assert.equal(r.code, 0, r.stderr);
  const renameIdx = r.stdout.indexOf('"name":"🟣 #42 Add retry logic to token refresh (v2)"');
  assert.ok(renameIdx > -1, "should rename");
  assert.ok(r.stdout.indexOf('"archived":true') > renameIdx, "should archive after rename");
});

test("title edit on merged PR (thread already archived): unarchives before rename", () => {
  const r = runFixture("edited_title_merged.json", "pull_request", {
    ...MERGED_THREAD_BEFORE_RENAME,
    DRY_RUN_CURRENT_ARCHIVED: "true",
  });
  assert.equal(r.code, 0, r.stderr);
  // Unarchive comes before the rename PATCH
  const unarchiveIdx = r.stdout.indexOf('"archived":false');
  const renameIdx = r.stdout.indexOf('"name":"🟣 #42 Add retry logic to token refresh (v2)"');
  assert.ok(unarchiveIdx > -1, "should unarchive first");
  assert.ok(renameIdx > -1, "should rename");
  assert.ok(unarchiveIdx < renameIdx, "unarchive must come before rename PATCH");
  // Re-archived after rename (closed PR)
  assert.match(r.stdout, /"archived":true/);
});

test("reopened PR (with tag change): unarchives thread and posts status", () => {
  const r = runFixture("reopened.json", "pull_request", {
    DRY_RUN_CURRENT_TAG_ID: "7", // was Closed
    DRY_RUN_CURRENT_THREAD_NAME: "🔴 #42 Add retry logic to token refresh",
    DRY_RUN_CURRENT_ARCHIVED: "true",
  });
  assert.equal(r.code, 0, r.stderr);
  // Tag updated to Open
  assert.match(r.stdout, /"applied_tags":\["2"\]/);
  // Name updated (prefix removed)
  assert.match(r.stdout, /"name":"#42 Add retry logic to token refresh"/);
  // Thread is unarchived before tag/name PATCH, not re-archived
  const unarchiveIdx = r.stdout.indexOf('"archived":false');
  const tagPatchIdx = r.stdout.indexOf('"applied_tags":');
  const postIdx = r.stdout.indexOf("POST https://discord.com/api/v10/channels/1234567890/messages");
  assert.ok(unarchiveIdx > -1, "should unarchive");
  assert.ok(tagPatchIdx > -1, "should update tag");
  assert.ok(postIdx > -1, "should post status message");
  assert.ok(unarchiveIdx < tagPatchIdx, "unarchive must come before tag/name PATCH");
  assert.match(r.stdout, /🟢 Open for review/);
  assert.doesNotMatch(r.stdout, /"archived":true/);
});

test("reopened PR (no tag/name delta, thread still archived): unarchives without posting", () => {
  const r = runFixture("reopened.json", "pull_request", {
    DRY_RUN_CURRENT_TAG_ID: "2", // already Open
    DRY_RUN_CURRENT_THREAD_NAME: "#42 Add retry logic to token refresh", // already correct
    DRY_RUN_CURRENT_ARCHIVED: "true",
  });
  assert.equal(r.code, 0, r.stderr);
  // No tag or name PATCH needed
  assert.doesNotMatch(r.stdout, /applied_tags/);
  // No status message posted (needsStatusLine is false)
  assert.doesNotMatch(r.stdout, /POST https:\/\/discord\.com\/api\/v10\/channels\/1234567890\/messages/);
  // But thread IS unarchived
  assert.match(r.stdout, /"archived":false/);
  // And NOT re-archived
  assert.doesNotMatch(r.stdout, /"archived":true/);
});

test("merged PR already archived + tag change: unarchives before post, re-archives after", () => {
  const r = runFixture("closed_merged.json", "pull_request", {
    DRY_RUN_CURRENT_THREAD_NAME: "#42 Add retry logic to token refresh",
    DRY_RUN_CURRENT_ARCHIVED: "true",
  });
  assert.equal(r.code, 0, r.stderr);
  // Unarchive comes before tag/name PATCH and status message, archive comes after
  const unarchiveIdx = r.stdout.indexOf('"archived":false');
  const tagPatchIdx = r.stdout.indexOf('"applied_tags":');
  const postIdx = r.stdout.indexOf("POST https://discord.com/api/v10/channels/1234567890/messages");
  const archiveIdx = r.stdout.lastIndexOf('"archived":true');
  assert.ok(unarchiveIdx > -1, "should unarchive first");
  assert.ok(unarchiveIdx < tagPatchIdx, "unarchive must come before tag/name PATCH");
  assert.ok(unarchiveIdx < postIdx, "unarchive must come before status message");
  assert.ok(archiveIdx > postIdx, "archive must come after status message");
});

test("merged PR with long title: prefix + title truncated to 100 chars", () => {
  const base = JSON.parse(readFileSync(join(FIXTURES, "closed_merged.json"), "utf8"));
  base.pull_request.title = "A".repeat(95);

  const dir = mkdtempSync(join(tmpdir(), "sync-pr-test-"));
  const fixturePath = join(dir, "long-title-merged.json");
  writeFileSync(fixturePath, JSON.stringify(base), "utf8");

  const r = run({
    env: {
      GITHUB_EVENT_PATH: fixturePath,
      GITHUB_EVENT_NAME: "pull_request",
      DRY_RUN_CURRENT_THREAD_NAME: "#42 " + "A".repeat(95),
    },
  });

  assert.equal(r.code, 0, r.stderr);
  // Extract the thread name from the PATCH body
  const nameMatch = r.stdout.match(/"name":"([^"]+)"/);
  assert.ok(nameMatch, "PATCH should include a name field");
  const threadName = nameMatch[1];
  // Must start with prefix and end with ellipsis, total ≤ 100 chars
  assert.ok(threadName.startsWith("🟣 #42 "), "should start with 🟣 prefix");
  assert.ok(threadName.endsWith("…"), "should end with ellipsis");
  assert.ok(threadName.length <= 100, `thread name should be ≤100 chars, got ${threadName.length}`);
});

// ---------- Thread label release on close ----------

function runMutatedFixture(fixture, eventName, mutate, extraEnv = {}) {
  const base = JSON.parse(readFileSync(join(FIXTURES, fixture), "utf8"));
  mutate(base);
  const dir = mkdtempSync(join(tmpdir(), "sync-pr-test-"));
  const fixturePath = join(dir, fixture);
  writeFileSync(fixturePath, JSON.stringify(base), "utf8");
  return run({
    env: { GITHUB_EVENT_PATH: fixturePath, GITHUB_EVENT_NAME: eventName, ...extraEnv },
  });
}

const DELETE_THREAD_LABEL =
  "DELETE https://api.github.com/repos/KZ-OWNER/test-repo/labels/discord-thread%3A1234567890";

test("merged PR: deletes its discord-thread label from the repo", () => {
  const r = runFixture("closed_merged.json", "pull_request");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(DELETE_THREAD_LABEL), r.stdout);
});

test("closed without merge: deletes its discord-thread label from the repo", () => {
  const r = runFixture("closed_not_merged.json", "pull_request");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(DELETE_THREAD_LABEL), r.stdout);
});

test("event on a closed PR whose label is gone: no new thread, no label", () => {
  const r = runMutatedFixture("review_changes_requested.json", "pull_request_review", (e) => {
    e.pull_request.state = "closed";
    e.pull_request.merged = true;
    e.pull_request.labels = [];
  });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /POST https:\/\/discord\.com/);
  assert.doesNotMatch(r.stdout, /POST https:\/\/api\.github\.com/);
  assert.match(r.stdout, /closed and has no thread/);
});

test("reopened PR whose label was released: starts a new thread and keeps its label", () => {
  const r = runMutatedFixture("reopened.json", "pull_request", (e) => {
    e.pull_request.labels = [];
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /POST https:\/\/discord\.com\/api\/v10\/channels\/1234\/threads/);
  assert.match(r.stdout, /Created thread DRY_RUN_THREAD_ID/);
  assert.doesNotMatch(r.stdout, /DELETE/);
});

test("title edit on a merged PR that still has a label: renames, then deletes the label", () => {
  const r = runFixture("edited_title_merged.json", "pull_request", MERGED_THREAD_BEFORE_RENAME);
  assert.equal(r.code, 0, r.stderr);
  const renameIdx = r.stdout.indexOf('"name":"🟣 #42 Add retry logic to token refresh (v2)"');
  assert.ok(renameIdx > -1, r.stdout);
  assert.ok(renameIdx < r.stdout.indexOf(DELETE_THREAD_LABEL), r.stdout);
});

test("title edit on a merged PR whose thread is on a stale tag: syncs to Merged, then deletes the label", () => {
  const r = runFixture("edited_title_merged.json", "pull_request", {
    DRY_RUN_CURRENT_TAG_ID: "5",
    DRY_RUN_CURRENT_THREAD_NAME: "#42 Add retry logic",
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"applied_tags":\["6"\]/);
  assert.match(r.stdout, /"name":"🟣 #42 Add retry logic to token refresh \(v2\)"/);
  assert.match(r.stdout, /"archived":true/);
  assert.ok(r.stdout.indexOf('"applied_tags":["6"]') < r.stdout.indexOf(DELETE_THREAD_LABEL), r.stdout);
});

test("body-only edit on a merged PR that still has a label: syncs to Merged, archives, deletes the label", () => {
  const r = runMutatedFixture("edited_body_only.json", "pull_request", (e) => {
    e.pull_request.state = "closed";
    e.pull_request.merged = true;
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"applied_tags":\["6"\]/);
  assert.match(r.stdout, /"archived":true/);
  assert.ok(r.stdout.includes(DELETE_THREAD_LABEL), r.stdout);
});

// A non-close event that syncs a closed PR to its final state reports who
// merged it, not who sent the event.
test("edit on a merged PR with a stale tag: status line credits the merger, not the editor", () => {
  const r = runMutatedFixture("edited_body_only.json", "pull_request", (e) => {
    e.pull_request.state = "closed";
    e.pull_request.merged = true;
    e.pull_request.merged_by = { login: "merger" };
    e.sender = { login: "editor" };
  }, { DRY_RUN_CURRENT_TAG_ID: "5" });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"content":"🟣 Merged by @merger"/);
  assert.doesNotMatch(r.stdout, /@editor/);
});

test("review on a PR closed without merge since: status line names no actor", () => {
  const r = runFixture("review_changes_requested.json", "pull_request_review", {
    DRY_RUN_FRESH_PR_JSON: freshPrFrom("review_changes_requested.json", (pr) => {
      pr.state = "closed";
      pr.merged = false;
    }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"content":"🔴 Closed without merging"/);
});

test("open PR events never delete the thread label", () => {
  for (const [fixture, eventName] of [
    ["review_requested.json", "pull_request"],
    ["edited_title.json", "pull_request"],
    ["reopened.json", "pull_request"],
  ]) {
    const r = runFixture(fixture, eventName);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /DELETE/, fixture);
  }
});

// The event payload is a snapshot; runs are queued per PR, so by the time a
// run starts the PR may have been closed or reopened. The fresh PR wins.

function freshPrFrom(fixture, mutate) {
  const pr = JSON.parse(readFileSync(join(FIXTURES, fixture), "utf8")).pull_request;
  mutate(pr);
  return JSON.stringify(pr);
}

test("stale open payload, PR merged since: syncs to Merged, archives, deletes the label", () => {
  const r = runFixture("review_requested.json", "pull_request", {
    DRY_RUN_FRESH_PR_JSON: freshPrFrom("review_requested.json", (pr) => {
      pr.state = "closed";
      pr.merged = true;
    }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"applied_tags":\["6"\]/);
  assert.doesNotMatch(r.stdout, /"applied_tags":\["2"\]/);
  assert.match(r.stdout, /"archived":true/);
  assert.ok(r.stdout.includes(DELETE_THREAD_LABEL), r.stdout);
});

test("stale open payload, PR closed without merge since: syncs to Closed, archives, deletes the label", () => {
  const r = runFixture("review_requested.json", "pull_request", {
    DRY_RUN_FRESH_PR_JSON: freshPrFrom("review_requested.json", (pr) => {
      pr.state = "closed";
      pr.merged = false;
    }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"applied_tags":\["7"\]/);
  assert.match(r.stdout, /"archived":true/);
  assert.ok(r.stdout.includes(DELETE_THREAD_LABEL), r.stdout);
});

test("open PR whose label was released while the run was queued: starts a new thread", () => {
  // Deliberate: the fresh PR is the source of truth, so a label that is only
  // in the stale payload does not count. The old thread was archived on close.
  const r = runFixture("review_requested.json", "pull_request", {
    DRY_RUN_FRESH_PR_JSON: freshPrFrom("review_requested.json", (pr) => {
      pr.labels = [];
    }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /POST https:\/\/discord\.com\/api\/v10\/channels\/1234\/threads/);
  assert.doesNotMatch(r.stdout, /channels\/1234567890/);
  assert.match(r.stdout, /"name":"discord-thread:DRY_RUN_THREAD_ID"/);
});

test("stale open payload, PR merged and label already gone: no new thread", () => {
  const r = runFixture("opened.json", "pull_request", {
    DRY_RUN_FRESH_PR_JSON: freshPrFrom("opened.json", (pr) => {
      pr.state = "closed";
      pr.merged = true;
    }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /POST https:\/\/discord\.com/);
  assert.match(r.stdout, /closed and has no thread label/);
});

test("review on a merged PR that still has a label: keeps Merged tag, archives, deletes the label", () => {
  const r = runMutatedFixture("review_changes_requested.json", "pull_request_review", (e) => {
    e.pull_request.state = "closed";
    e.pull_request.merged = true;
  }, { DRY_RUN_CURRENT_TAG_ID: "6", DRY_RUN_CURRENT_ARCHIVED: "true" });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /"applied_tags":\["3"\]/);
  assert.doesNotMatch(r.stdout, /"archived":false/);
  // Discord rejects edits to an archived thread unless they unarchive it,
  // so an already archived thread must get no archive PATCH either.
  assert.doesNotMatch(r.stdout, /"archived":true/);
  assert.ok(r.stdout.includes(DELETE_THREAD_LABEL), r.stdout);
});

test("body-only edit on a merged PR whose thread is already archived: no Discord writes, deletes the label", () => {
  // e.g. a retry after the close run's label delete failed
  const r = runMutatedFixture("edited_body_only.json", "pull_request", (e) => {
    e.pull_request.state = "closed";
    e.pull_request.merged = true;
  }, { DRY_RUN_CURRENT_TAG_ID: "6", DRY_RUN_CURRENT_THREAD_NAME: "🟣 #42 Add retry logic to token refresh", DRY_RUN_CURRENT_ARCHIVED: "true" });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /PATCH https:\/\/discord\.com/);
  assert.ok(r.stdout.includes(DELETE_THREAD_LABEL), r.stdout);
});

test("stale closed payload, PR reopened since: skips, keeps the label", () => {
  const r = runFixture("closed_merged.json", "pull_request", {
    DRY_RUN_FRESH_PR_JSON: freshPrFrom("closed_merged.json", (pr) => {
      pr.state = "open";
      pr.merged = false;
    }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /DELETE/);
  assert.doesNotMatch(r.stdout, /PATCH/);
  assert.match(r.stdout, /reopened since/);
});

test("closed event for a PR that never had a thread: creates nothing", () => {
  const r = runMutatedFixture("closed_merged.json", "pull_request", (e) => {
    e.pull_request.labels = [];
  });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /POST https:\/\/discord\.com/);
  assert.doesNotMatch(r.stdout, /POST https:\/\/api\.github\.com/);
});

test("merged PR with two thread labels (old duplicate-thread race): deletes both", () => {
  const r = runMutatedFixture("closed_merged.json", "pull_request", (e) => {
    e.pull_request.labels.push({ name: "discord-thread:2222222222222222" });
  });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(DELETE_THREAD_LABEL), r.stdout);
  assert.ok(
    r.stdout.includes("DELETE https://api.github.com/repos/KZ-OWNER/test-repo/labels/discord-thread%3A2222222222222222"),
    r.stdout,
  );
});

test("label already deleted (404): still succeeds", () => {
  const r = runFixture("closed_merged.json", "pull_request", {
    DRY_RUN_LABEL_DELETE_STATUS: "404",
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Label discord-thread:1234567890 already deleted/);
});

test("label delete fails for another reason: run fails", () => {
  const r = runFixture("closed_merged.json", "pull_request", {
    DRY_RUN_LABEL_DELETE_STATUS: "403",
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /403/);
});
