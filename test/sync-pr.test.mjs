// End-to-end tests for scripts/sync-pr.mjs.
// Zero dependencies. Run with: node --test test/sync-pr.test.mjs
//
// Strategy: spawn the script as a subprocess in --dry-run mode against
// fixture event payloads and assert on stdout/stderr/exit-code. Dry-run
// short-circuits non-GET HTTP requests and also stubs the PR-reviews GET
// (needed by the review_requested path). DISCORD_TAG_IDS_JSON is set so
// resolveTagIds skips the Discord channel fetch. The Discord /channels/:id
// GET used by getThread is not called under dry-run — tests can instead set
// DRY_RUN_CURRENT_TAG_ID to simulate a thread that already has a given tag.

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
  // allowed_mentions suppresses @everyone/@here/role/user pings
  assert.match(r.stdout, /allowed_mentions/);
});

test("closed+merged PR: updates existing thread to Merged tag", () => {
  const r = runFixture("closed_merged.json", "pull_request");
  assert.equal(r.code, 0, r.stderr);
  // PATCH to existing thread id from label
  assert.match(r.stdout, /PATCH https:\/\/discord\.com\/api\/v10\/channels\/1234567890/);
  // Merged tag id (6) applied
  assert.match(r.stdout, /"applied_tags":\["6"\]/);
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
    GITHUB_TO_DISCORD_USER_MAP: JSON.stringify({ alice: "111111111111111111" }),
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
    GITHUB_TO_DISCORD_USER_MAP: JSON.stringify({ bob: "222222222222222222" }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /review requested from @alice/);
  assert.doesNotMatch(r.stdout, /"users":\[/);
});

test("review submitted: pings PR author when mapped", () => {
  const r = runFixture("review_changes_requested.json", "pull_request_review", {
    GITHUB_TO_DISCORD_USER_MAP: JSON.stringify({ kz: "333333333333333333" }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /🛠️ Changes requested by @bob — cc <@333333333333333333>/);
  assert.match(r.stdout, /"allowed_mentions":\{"parse":\[\],"users":\["333333333333333333"\]\}/);
});

test("review submitted: no cc when author has no mapping", () => {
  const r = runFixture("review_changes_requested.json", "pull_request_review", {
    GITHUB_TO_DISCORD_USER_MAP: JSON.stringify({ bob: "444444444444444444" }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /🛠️ Changes requested by @bob/);
  assert.doesNotMatch(r.stdout, / — cc </);
  assert.doesNotMatch(r.stdout, /"users":\[/);
});

test("invalid Discord IDs in user map are dropped with a warning", () => {
  const r = runFixture("review_requested.json", "pull_request", {
    GITHUB_TO_DISCORD_USER_MAP: JSON.stringify({ alice: "not-a-snowflake" }),
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /dropping "alice"/);
  assert.match(r.stdout, /review requested from @alice/);
  assert.doesNotMatch(r.stdout, /"users":\[/);
});

test("malformed GITHUB_TO_DISCORD_USER_MAP: warns and disables mentions", () => {
  const r = runFixture("review_requested.json", "pull_request", {
    GITHUB_TO_DISCORD_USER_MAP: "{not json",
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
    GITHUB_TO_DISCORD_USER_MAP: JSON.stringify({ alice: "111111111111111111" }),
    DRY_RUN_CURRENT_TAG_ID: "2",
  });
  assert.equal(r.code, 0, r.stderr);
  // Tag-change PATCH must NOT fire.
  assert.doesNotMatch(r.stdout, /"applied_tags":/);
  // 🔔 branch posted with real ping.
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
      GITHUB_TO_DISCORD_USER_MAP: JSON.stringify({ bob: "555555555555555555" }),
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
      GITHUB_TO_DISCORD_USER_MAP: JSON.stringify({ alice: "111111111111111111" }),
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
