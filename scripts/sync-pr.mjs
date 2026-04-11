#!/usr/bin/env node
// Sync GitHub PR events to a Discord forum thread.
// Zero dependencies. Node 20+ (uses built-in fetch).

import { readFileSync } from "node:fs";

const DRY_RUN = process.argv.includes("--dry-run");

const {
  GITHUB_EVENT_PATH,
  GITHUB_EVENT_NAME,
  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
  DISCORD_BOT_TOKEN,
  DISCORD_FORUM_CHANNEL_ID,
  DISCORD_TAG_IDS_JSON,
  DISCORD_USER_MAP_JSON,
} = process.env;

const TAG_NAMES = [
  "Draft",
  "Open",
  "Changes Requested",
  "Re-review Requested",
  "Approved",
  "Merged",
  "Closed",
];

const STATUS_LINES = {
  Draft: "📝 Marked as draft",
  Open: "🟢 Open for review",
  "Changes Requested": "🛠️ Changes requested",
  "Re-review Requested": "🔁 Re-review requested",
  Approved: "✅ Approved",
  Merged: "🟣 Merged",
  Closed: "⚪ Closed without merging",
};

const THREAD_LABEL_PREFIX = "discord-thread:";
const DISCORD_SNOWFLAKE_RE = /^\d{5,25}$/;

// ---------- HTTP helpers ----------

async function http(url, init = {}, { retried = false } = {}) {
  if (DRY_RUN && init.method && init.method !== "GET") {
    console.log(`[dry-run] ${init.method} ${url}`);
    if (init.body) console.log(`[dry-run] body: ${init.body}`);
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }
  if (
    DRY_RUN &&
    (!init.method || init.method === "GET") &&
    url.startsWith("https://api.github.com") &&
    /\/pulls\/\d+\/reviews/.test(url)
  ) {
    // Stub the PR-reviews GET in dry-run so tests can exercise branches that
    // fetch reviews (e.g. review_requested) without network access. Returns an
    // empty array — callers only use it to count prior reviews.
    console.log(`[dry-run] GET ${url}`);
    return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
  }
  const res = await fetch(url, init);
  if (res.status === 429 && !retried) {
    const retryAfter = Number(res.headers.get("retry-after") || "1");
    await sleep(retryAfter * 1000);
    return http(url, init, { retried: true });
  }
  if (res.status >= 500 && res.status < 600 && !retried) {
    await sleep(1000);
    return http(url, init, { retried: true });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const truncated = body.length > 200 ? body.slice(0, 200) + "…" : body;
    const err = new Error(`${init.method || "GET"} ${url} failed: ${res.status} ${truncated}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gh = (path, init = {}) =>
  http(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

const discord = (path, init = {}) =>
  http(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

// ---------- Tag id resolution ----------

async function resolveTagIds() {
  if (DISCORD_TAG_IDS_JSON) {
    try {
      const parsed = JSON.parse(DISCORD_TAG_IDS_JSON);
      if (TAG_NAMES.every((n) => parsed[n])) return parsed;
    } catch {
      // fall through to refetch
    }
  }
  const res = await discord(`/channels/${DISCORD_FORUM_CHANNEL_ID}`);
  const channel = await res.json();
  const available = channel.available_tags || [];
  const map = {};
  for (const name of TAG_NAMES) {
    const tag = available.find((t) => t.name === name);
    if (!tag) {
      throw new Error(
        `Discord forum tag "${name}" not found in channel ${DISCORD_FORUM_CHANNEL_ID}. ` +
          `Existing tags: ${available.map((t) => t.name).join(", ")}`
      );
    }
    map[name] = tag.id;
  }
  console.log(
    `Resolved Discord tag ids. Cache them by setting repo variable DISCORD_TAG_IDS_JSON to:\n${JSON.stringify(
      map
    )}`
  );
  return map;
}

// ---------- User mention map ----------

function loadUserMap() {
  if (!DISCORD_USER_MAP_JSON) return {};
  let parsed;
  try {
    parsed = JSON.parse(DISCORD_USER_MAP_JSON);
  } catch {
    console.warn("DISCORD_USER_MAP_JSON is not valid JSON; mentions disabled.");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("DISCORD_USER_MAP_JSON must be a JSON object; mentions disabled.");
    return {};
  }
  const map = {};
  for (const [login, id] of Object.entries(parsed)) {
    if (typeof id === "string" && DISCORD_SNOWFLAKE_RE.test(id)) {
      map[login] = id;
    } else {
      console.warn(`DISCORD_USER_MAP_JSON: dropping "${login}" — invalid Discord ID.`);
    }
  }
  return map;
}

// ---------- State machine ----------

function isBot(user) {
  return user && user.type === "Bot";
}

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

async function recomputeStateFromScratch(pr, owner, repo) {
  if (pr.state === "closed") return pr.merged ? "Merged" : "Closed";
  if (pr.draft) return "Draft";
  const reviews = await fetchReviews(owner, repo, pr.number);
  const humanReviews = reviews.filter((r) => r.user && !isBot(r.user));
  // Latest review per reviewer wins.
  const latestByUser = new Map();
  for (const r of humanReviews) {
    const prev = latestByUser.get(r.user.login);
    if (!prev || new Date(r.submitted_at) > new Date(prev.submitted_at)) {
      latestByUser.set(r.user.login, r);
    }
  }
  const states = [...latestByUser.values()].map((r) => r.state);
  if (states.includes("CHANGES_REQUESTED")) return "Changes Requested";
  if (states.includes("APPROVED")) return "Approved";
  // No blocking reviews. Are reviewers currently requested?
  const reviewersRequested =
    (pr.requested_reviewers && pr.requested_reviewers.length > 0) ||
    (pr.requested_teams && pr.requested_teams.length > 0);
  if (reviewersRequested && humanReviews.length > 0) return "Re-review Requested";
  return "Open";
}

async function computeDesiredState(event, eventName, owner, repo) {
  const pr = event.pull_request;
  const action = event.action;

  if (eventName === "pull_request") {
    if (action === "closed") return pr.merged ? "Merged" : "Closed";
    if (action === "converted_to_draft") return "Draft";
    if (action === "ready_for_review") return await recomputeStateFromScratch(pr, owner, repo);
    if (action === "opened") return pr.draft ? "Draft" : "Open";
    if (action === "reopened") return await recomputeStateFromScratch(pr, owner, repo);
    if (action === "edited") return null; // title-only handling done elsewhere
    if (action === "review_requested") {
      const reviews = await fetchReviews(owner, repo, pr.number);
      const hasPriorHumanReview = reviews.some((r) => !isBot(r.user));
      return hasPriorHumanReview ? "Re-review Requested" : "Open";
    }
    if (action === "review_request_removed") {
      return await recomputeStateFromScratch(pr, owner, repo);
    }
  }

  if (eventName === "pull_request_review") {
    if (isBot(event.review.user)) return null; // ignore bot reviews
    if (action === "submitted") {
      const s = event.review.state;
      if (s === "changes_requested") return "Changes Requested";
      if (s === "approved") return await recomputeStateFromScratch(pr, owner, repo);
      if (s === "commented") return null; // plain comment doesn't change state
    }
    if (action === "dismissed") {
      return await recomputeStateFromScratch(pr, owner, repo);
    }
  }

  return null;
}

// ---------- Label helpers ----------

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

function assertValidDiscordSnowflake(value, context) {
  if (!DISCORD_SNOWFLAKE_RE.test(value)) {
    throw new Error(`Invalid Discord thread id in label (${context}): "${value}"`);
  }
}

async function ensureLabel(owner, repo, name, color, description) {
  try {
    await gh(`/repos/${owner}/${repo}/labels`, {
      method: "POST",
      body: JSON.stringify({ name, color, description }),
    });
  } catch (err) {
    const alreadyExists = err.status === 422 && err.message.includes("already_exists");
    if (!alreadyExists) throw err;
  }
}

async function addLabel(owner, repo, number, name) {
  await gh(`/repos/${owner}/${repo}/issues/${number}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: [name] }),
  });
}

// ---------- Discord ops ----------

function buildInitialPost(pr, userMap = {}) {
  const title = `**[#${pr.number} ${pr.title}](${pr.html_url})**`;
  const authorLogin = pr.user.login;
  const authorId = userMap[authorLogin];
  const authorMention = authorId ? `<@${authorId}>` : `@${authorLogin}`;
  const branches = `\`${pr.head.ref} → ${pr.base.ref}\``;
  const body = (pr.body || "").trim().slice(0, 300);
  const bodyLine = body ? `\n\n${body}${pr.body && pr.body.length > 300 ? "…" : ""}` : "";
  const content = `${title} by ${authorMention}\n${branches}${bodyLine}`;
  const mentionUserIds = authorId ? [authorId] : [];
  return { content, mentionUserIds };
}

function threadName(pr) {
  // Discord thread name max 100 chars.
  const raw = `#${pr.number} ${pr.title}`;
  return raw.length > 100 ? raw.slice(0, 99) + "…" : raw;
}

async function createForumThread(pr, tagId, userMap = {}) {
  const { content, mentionUserIds } = buildInitialPost(pr, userMap);
  const allowed_mentions =
    mentionUserIds.length > 0 ? { parse: [], users: mentionUserIds } : { parse: [] };
  const res = await discord(`/channels/${DISCORD_FORUM_CHANNEL_ID}/threads`, {
    method: "POST",
    body: JSON.stringify({
      name: threadName(pr),
      applied_tags: [tagId],
      message: { content, allowed_mentions },
    }),
  });
  if (DRY_RUN) return "DRY_RUN_THREAD_ID";
  const json = await res.json();
  return json.id;
}

async function getThread(threadId) {
  const res = await discord(`/channels/${threadId}`);
  return await res.json();
}

async function updateThreadTags(threadId, tagId) {
  await discord(`/channels/${threadId}`, {
    method: "PATCH",
    body: JSON.stringify({ applied_tags: [tagId] }),
  });
}

async function updateThreadName(threadId, name) {
  await discord(`/channels/${threadId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

async function postThreadMessage(threadId, content, mentionUserIds = []) {
  const allowed_mentions =
    mentionUserIds.length > 0 ? { parse: [], users: mentionUserIds } : { parse: [] };
  await discord(`/channels/${threadId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, allowed_mentions }),
  });
}

// Build the status/mention message for a thread update.
//
// Returns { content, mentionUserIds }. mentionUserIds is the set of Discord
// snowflakes that must be echoed into allowed_mentions.users for the ping to
// actually fire.
//
// Note on "opened" with reviewers: we deliberately don't mention reviewers
// here. GitHub fires a separate pull_request.review_requested event for each
// reviewer pre-assigned at PR creation, so those reviewers get pinged via the
// review_requested branch — mentioning them again on "opened" would double-ping.
function buildStatusMessage({ desired, event, eventName, userMap, tagChanged }) {
  const mentionUserIds = [];
  const pushMention = (login) => {
    const id = userMap[login];
    if (id) {
      mentionUserIds.push(id);
      return `<@${id}>`;
    }
    return `@${login}`;
  };

  if (eventName === "pull_request" && event.action === "review_requested") {
    // GitHub sends `requested_reviewer` for user requests and `requested_team`
    // for team requests. Teams can't be pinged via user snowflakes, so they
    // fall back to a plain-text team name.
    const reviewerLogin = event.requested_reviewer?.login;
    const teamName = event.requested_team?.name || event.requested_team?.slug;
    let mention;
    if (reviewerLogin) mention = pushMention(reviewerLogin);
    else if (teamName) mention = `team \`${teamName}\``;
    else mention = "someone";
    const content = tagChanged
      ? `${STATUS_LINES[desired]} — review requested from ${mention}`
      : `🔔 Review requested from ${mention}`;
    return { content, mentionUserIds };
  }

  const actor = event.review?.user?.login || event.sender?.login || "someone";
  let content = `${STATUS_LINES[desired]} by @${actor}`;

  if (eventName === "pull_request_review" && event.action === "submitted") {
    const authorLogin = event.pull_request?.user?.login;
    if (authorLogin && authorLogin !== actor && userMap[authorLogin]) {
      mentionUserIds.push(userMap[authorLogin]);
      content += ` — cc <@${userMap[authorLogin]}>`;
    }
  }

  return { content, mentionUserIds };
}

// ---------- Main ----------

async function main() {
  const required = [
    "GITHUB_EVENT_PATH",
    "GITHUB_EVENT_NAME",
    "GITHUB_TOKEN",
    "DISCORD_BOT_TOKEN",
    "DISCORD_FORUM_CHANNEL_ID",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8"));
  const eventName = GITHUB_EVENT_NAME;
  const pr = event.pull_request;
  if (!pr) {
    console.log(`No pull_request on event ${eventName}; skipping.`);
    return;
  }
  // Skip fork PRs (workflow already filters, but be defensive).
  const repoFull = GITHUB_REPOSITORY || `${event.repository.owner.login}/${event.repository.name}`;
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
  const [owner, repo] = repoFull.split("/");

  const tagIds = await resolveTagIds();
  const userMap = loadUserMap();

  // Title-only edit: just rename the thread, no tag change.
  if (eventName === "pull_request" && event.action === "edited") {
    const titleChanged = event.changes && event.changes.title;
    if (!titleChanged) {
      console.log("Edit event with no title change; nothing to do.");
      return;
    }
    const threadId = findThreadIdFromLabels(pr);
    if (!threadId) {
      console.log("Title edited but no thread label yet; nothing to rename.");
      return;
    }
    assertValidDiscordSnowflake(threadId, THREAD_LABEL_PREFIX);
    await updateThreadName(threadId, threadName(pr));
    console.log(`Renamed thread ${threadId}`);
    return;
  }

  const desired = await computeDesiredState(event, eventName, owner, repo);
  if (!desired) {
    console.log("No state change required.");
    return;
  }
  const desiredTagId = tagIds[desired];

  let threadId = findThreadIdFromLabels(pr);
  if (threadId) {
    assertValidDiscordSnowflake(threadId, THREAD_LABEL_PREFIX);
  }

  if (!threadId) {
    await ensureLabel(
      owner,
      repo,
      "discord-managed",
      "ededed",
      "Auto-managed by github-discord-pr-sync"
    );
    threadId = await createForumThread(pr, desiredTagId, userMap);
    const labelName = `${THREAD_LABEL_PREFIX}${threadId}`;
    await ensureLabel(owner, repo, labelName, "ededed", "Discord thread mapping");
    await addLabel(owner, repo, pr.number, labelName);
    console.log(`Created thread ${threadId} with tag ${desired}`);
    return;
  }

  // Existing thread: compare current vs desired tags, update if different.
  let currentTags = [];
  if (DRY_RUN) {
    // Test hook: lets suites simulate a thread that already has a given tag,
    // so the tag-unchanged branch of main() can be exercised without network.
    const stub = process.env.DRY_RUN_CURRENT_TAG_ID;
    if (stub) currentTags = [stub];
  } else {
    const thread = await getThread(threadId);
    currentTags = thread.applied_tags || [];
  }
  const tagChanged = !(currentTags.length === 1 && currentTags[0] === desiredTagId);
  if (tagChanged) {
    await updateThreadTags(threadId, desiredTagId);
  }

  // review_requested must post a mention even when the tag stays the same
  // (e.g. first review request on a fresh PR — state remains "Open").
  const isReviewRequested =
    eventName === "pull_request" && event.action === "review_requested";
  const needsStatusLine = tagChanged || isReviewRequested;

  if (!needsStatusLine) {
    console.log(`Tag already ${desired}; nothing to do.`);
    return;
  }

  const { content, mentionUserIds } = buildStatusMessage({
    desired,
    event,
    eventName,
    userMap,
    tagChanged,
  });
  await postThreadMessage(threadId, content, mentionUserIds);
  console.log(`Updated thread ${threadId} → ${desired}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
