#!/usr/bin/env node
// Sync GitHub PR events to a Discord forum thread.
// Zero dependencies (uses built-in fetch). Runs on the Node version action.yml sets up.

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
  Closed: "🔴 Closed without merging",
};

const THREAD_LABEL_PREFIX = "discord-thread:";
const DISCORD_SNOWFLAKE_RE = /^\d{5,25}$/;
const isTerminalState = (s) => s === "Merged" || s === "Closed";

// ---------- HTTP helpers ----------

async function http(url, init = {}, { retried = false } = {}) {
  if (DRY_RUN && init.method === "DELETE" && process.env.DRY_RUN_LABEL_DELETE_STATUS) {
    // Test hook: simulate a failed label DELETE (e.g. 404 already deleted).
    console.log(`[dry-run] DELETE ${url}`);
    const err = new Error(`DELETE ${url} failed: ${process.env.DRY_RUN_LABEL_DELETE_STATUS}`);
    err.status = Number(process.env.DRY_RUN_LABEL_DELETE_STATUS);
    throw err;
  }
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
    // fetch reviews (e.g. review_requested) without network access.
    //   DRY_RUN_REVIEWS_PAGES_JSON — JSON array of arrays, one per page, used
    //     to exercise pagination (adds a Link: rel="next" header when more
    //     pages remain; ?page=N in the URL selects the page).
    //   DRY_RUN_REVIEWS_JSON — single-page shorthand (legacy).
    //   default — empty array.
    console.log(`[dry-run] GET ${url}`);
    if (process.env.DRY_RUN_REVIEWS_PAGES_JSON) {
      const pages = JSON.parse(process.env.DRY_RUN_REVIEWS_PAGES_JSON);
      const pageNum = Number(new URL(url).searchParams.get("page") || "1");
      const body = pages[pageNum - 1] || [];
      const headers = new Map();
      if (pageNum < pages.length) {
        const nextUrl = /[?&]page=\d+/.test(url)
          ? url.replace(/([?&])page=\d+/, `$1page=${pageNum + 1}`)
          : `${url}&page=${pageNum + 1}`;
        headers.set("link", `<${nextUrl}>; rel="next"`);
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }
    const reviews = process.env.DRY_RUN_REVIEWS_JSON
      ? JSON.parse(process.env.DRY_RUN_REVIEWS_JSON)
      : [];
    return { ok: true, status: 200, json: async () => reviews, text: async () => JSON.stringify(reviews) };
  }
  if (
    DRY_RUN &&
    (!init.method || init.method === "GET") &&
    url.startsWith("https://api.github.com") &&
    /\/pulls\/\d+$/.test(url)
  ) {
    // Stub the fresh single-PR GET made on every run. Returns
    // DRY_RUN_FRESH_PR_JSON if set, otherwise the event's own pull_request
    // (i.e. nothing changed since the event fired).
    console.log(`[dry-run] GET ${url}`);
    const pr = process.env.DRY_RUN_FRESH_PR_JSON
      ? JSON.parse(process.env.DRY_RUN_FRESH_PR_JSON)
      : JSON.parse(readFileSync(GITHUB_EVENT_PATH, "utf8")).pull_request;
    return { ok: true, status: 200, json: async () => pr, text: async () => JSON.stringify(pr) };
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

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
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
    // Headers mirror gh() — keep in sync if gh() changes.
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

// ---------- Thread mapping (PR ↔ Discord thread) ----------
//
// The mapping lives in a repo label named `discord-thread:<id>` attached to
// the PR. Callers only see find / prepare / save / release; label names
// and validation stay in here.

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

function threadMapping({ owner, repo }) {
  const threadLabelNames = (pr) =>
    (pr.labels || []).map((lbl) => lbl.name).filter((name) => name?.startsWith(THREAD_LABEL_PREFIX));

  return {
    // Thread id recorded on this PR, or null. Pass a freshly fetched PR:
    // event payload labels may be stale. Throws on a malformed label.
    find(pr) {
      const [first, ...rest] = threadLabelNames(pr);
      if (!first) return null;
      const found = first.slice(THREAD_LABEL_PREFIX.length);
      if (rest.length > 0) {
        console.warn(`Multiple ${THREAD_LABEL_PREFIX} labels found; using first: ${found}`);
      }
      if (!DISCORD_SNOWFLAKE_RE.test(found)) {
        throw new Error(`Invalid Discord thread id in label "${THREAD_LABEL_PREFIX}${found}"`);
      }
      return found;
    },

    // Call before creating a thread. Writes a label, so a token that can't
    // write labels fails here, before a thread exists that `save` can't record.
    async prepare() {
      await ensureLabel(owner, repo, "discord-managed", "ededed", "Auto-managed by github-discord-pr-sync");
    },

    // Record that this PR's thread is `threadId`.
    async save(pr, threadId) {
      const name = `${THREAD_LABEL_PREFIX}${threadId}`;
      await ensureLabel(owner, repo, name, "ededed", "Discord thread mapping");
      await gh(`/repos/${owner}/${repo}/issues/${pr.number}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: [name] }),
      });
    },

    // Forget the mapping by deleting every thread label on `pr` from the
    // repo (which also removes it from the PR). That includes extra labels
    // `find` ignores, left by the old duplicate-thread race. Idempotent: an
    // already-deleted label is not an error.
    async release(pr) {
      for (const name of threadLabelNames(pr)) {
        try {
          await gh(`/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`, { method: "DELETE" });
          console.log(`Released label ${name}`);
        } catch (err) {
          if (err.status !== 404) throw err;
          console.log(`Label ${name} already deleted`);
        }
      }
    },
  };
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

function prefixState(pr) {
  if (pr.state !== "closed") return null;
  return pr.merged ? "Merged" : "Closed";
}

function threadName(pr) {
  // Discord thread name max 100 chars.
  const state = prefixState(pr);
  const prefix = state === "Merged" ? "🟣 " : state === "Closed" ? "🔴 " : "";
  const raw = `${prefix}#${pr.number} ${pr.title}`;
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

async function updateThread(threadId, fields) {
  await discord(`/channels/${threadId}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
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
function buildStatusMessage({ desired, pr, event, eventName, userMap, tagChanged }) {
  const mentionUserIds = [];
  const pushMention = (login) => {
    const id = userMap[login];
    if (id) {
      mentionUserIds.push(id);
      return `<@${id}>`;
    }
    return `@${login}`;
  };

  // A closed PR synced by some later event (edit, review, a stale payload):
  // the event's sender didn't close it. Credit the merger when GitHub says who
  // it was; the PR object doesn't name who closed without merging.
  const isCloseEvent = eventName === "pull_request" && event.action === "closed";
  if (isTerminalState(desired) && !isCloseEvent) {
    const merger = desired === "Merged" ? pr.merged_by?.login : null;
    const content = merger ? `${STATUS_LINES[desired]} by @${merger}` : STATUS_LINES[desired];
    return { content, mentionUserIds: [] };
  }

  // ready_for_review: the actor just un-drafted the PR. Report that action,
  // not the recomputed tag state (which may replay an old review verdict).
  if (eventName === "pull_request" && event.action === "ready_for_review") {
    const actor = event.sender?.login || "someone";
    return { content: `🟢 Marked as ready for review by @${actor}`, mentionUserIds: [] };
  }

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
  const mapping = threadMapping({ owner, repo });

  // Runs are queued per PR, so the PR may have changed since this event
  // fired. Its current state decides what happens to the thread and label.
  const current = await (await gh(`/repos/${owner}/${repo}/pulls/${pr.number}`)).json();
  const closed = current.state === "closed";
  if (pr.state === "closed" && !closed) {
    console.log("PR was reopened since this close event; skipping.");
    return;
  }

  const threadId = mapping.find(current);
  if (!threadId && closed) {
    // Closing releases the mapping, so later events on a closed PR have
    // nothing to look up. Don't start a new thread for them.
    console.log("PR is closed and has no thread label; skipping.");
    return;
  }

  // On a closed PR this may be the last run that sees the label, so any event,
  // edits included, takes the full sync to the final state below.
  if (eventName === "pull_request" && event.action === "edited" && !closed) {
    // Title-only edit: just rename the thread, no tag change.
    if (!event.changes?.title) {
      console.log("Edit event with no title change; nothing to do.");
      return;
    }
    if (!threadId) {
      console.log("Title edited but no thread label yet; nothing to rename.");
      return;
    }
    await renameThread(threadId, current);
  } else {
    // A closed PR always shows its final state, whatever this event says.
    const desired = closed
      ? current.merged ? "Merged" : "Closed"
      : await computeDesiredState(event, eventName, owner, repo);
    if (!desired) {
      console.log("No state change required.");
      return;
    }
    if (!threadId) {
      await mapping.prepare();
      const newId = await createForumThread(current, tagIds[desired], userMap);
      await mapping.save(current, newId);
      console.log(`Created thread ${newId} with tag ${desired}`);
      // The new thread already has the desired tag and name, so this posts
      // only the status line the event calls for. CODEOWNERS requests
      // reviewers as the PR opens, so a review_requested run can create the
      // thread, and the opened run that follows posts nothing: this is the
      // reviewer's only ping. It runs after save, so a failed post is retried
      // through the existing-thread path.
      const created = { tags: [tagIds[desired]], name: threadName(current), archived: false };
      await syncExistingThread({
        threadId: newId,
        thread: created,
        desired,
        pr: current,
        event,
        eventName,
        tagIds,
        userMap,
      });
      return;
    }
    const thread = await readThread(threadId, threadName(current));
    await syncExistingThread({
      threadId,
      thread,
      desired,
      pr: current,
      event,
      eventName,
      tagIds,
      userMap,
    });
  }

  // Last step, so a failed Discord call above leaves the mapping for a retry.
  if (closed) await mapping.release(current);
}

async function renameThread(threadId, pr) {
  let isArchived = false;
  if (DRY_RUN) {
    isArchived = process.env.DRY_RUN_CURRENT_ARCHIVED === "true";
  } else {
    const thread = await getThread(threadId);
    isArchived = thread.thread_metadata?.archived ?? false;
  }
  if (isArchived) {
    await updateThread(threadId, { archived: false });
  }
  await updateThread(threadId, { name: threadName(pr) });
  console.log(`Renamed thread ${threadId}`);
}

// The thread's current tags, name and archive state, as syncExistingThread
// takes them. `newName` is the name the thread should have.
async function readThread(threadId, newName) {
  if (DRY_RUN) {
    // Test hooks: simulate a thread that already has a given tag/name/archived
    // state without network access. DRY_RUN_CURRENT_THREAD_NAME uses ?? (not ||)
    // so empty string is a valid stub; when unset, defaults to newName (no name
    // change). DRY_RUN_CURRENT_ARCHIVED defaults to false when unset.
    const stub = process.env.DRY_RUN_CURRENT_TAG_ID;
    return {
      tags: stub ? [stub] : [],
      name: process.env.DRY_RUN_CURRENT_THREAD_NAME ?? newName,
      archived: process.env.DRY_RUN_CURRENT_ARCHIVED === "true",
    };
  }
  const thread = await getThread(threadId);
  return {
    tags: thread.applied_tags || [],
    name: thread.name || "",
    archived: thread.thread_metadata?.archived ?? false,
  };
}

// Bring a thread's tag, name and archive state in line with `desired`,
// posting a status line when something worth reporting changed. `thread` is
// its current state, from readThread or, for a thread just created, known.
async function syncExistingThread({ threadId, thread, desired, pr, event, eventName, tagIds, userMap }) {
  const desiredTagId = tagIds[desired];
  const newName = threadName(pr);
  const { tags: currentTags, name: currentName, archived: currentlyArchived } = thread;

  const tagChanged = !(currentTags.length === 1 && currentTags[0] === desiredTagId);
  const nameChanged = currentName !== newName;

  // review_requested and ready_for_review must post a status line even when the
  // tag stays the same (e.g. first review request on a fresh PR — state remains
  // "Open"; or undrafting when the tag was already correct).
  const isReviewRequested =
    eventName === "pull_request" && event.action === "review_requested";
  const isReadyForReview =
    eventName === "pull_request" && event.action === "ready_for_review";
  const needsStatusLine = tagChanged || isReviewRequested || isReadyForReview;

  // Ensure thread is unarchived before any mutating PATCH. Discord rejects
  // PATCH on archived threads with error 50083 ("Thread is archived").
  // This covers: reopen on an archived thread, terminal state retry,
  // and name-only changes on archived terminal threads.
  let archived = currentlyArchived;
  if (archived && (tagChanged || nameChanged || needsStatusLine || !isTerminalState(desired))) {
    await updateThread(threadId, { archived: false });
    archived = false;
  }
  // Same rule: an already archived thread can't take another archive PATCH.
  const archiveIfTerminal = async () => {
    if (isTerminalState(desired) && !archived) await updateThread(threadId, { archived: true });
  };

  // Combined PATCH for tag and/or name.
  if (tagChanged && nameChanged) {
    await updateThread(threadId, { applied_tags: [desiredTagId], name: newName });
  } else if (tagChanged) {
    await updateThread(threadId, { applied_tags: [desiredTagId] });
  } else if (nameChanged) {
    await updateThread(threadId, { name: newName });
  }

  if (!needsStatusLine) {
    await archiveIfTerminal();
    if (nameChanged) {
      console.log(`Updated thread ${threadId} name`);
    } else {
      console.log(`Tag already ${desired}; nothing to do.`);
    }
    return;
  }

  const { content, mentionUserIds } = buildStatusMessage({
    desired,
    pr,
    event,
    eventName,
    userMap,
    tagChanged,
  });
  await postThreadMessage(threadId, content, mentionUserIds);
  await archiveIfTerminal();
  console.log(`Updated thread ${threadId} → ${desired}`);
}


main().catch((err) => {
  console.error(err);
  process.exit(1);
});
