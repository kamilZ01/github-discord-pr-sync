#!/usr/bin/env node
// One-off cleanup: delete `discord-thread:<id>` repo labels that the sync
// action no longer needs, i.e. labels whose PRs are all closed (merged or not)
// and labels attached to no PR at all. Labels on open PRs are kept.
//
// Prints the plan by default. Pass --apply to delete.
//
//   GITHUB_TOKEN=$(gh auth token) node scripts/cleanup-labels.mjs owner/repo [owner/repo ...] [--apply]
//
// Zero dependencies. Node 20+.

const THREAD_LABEL_PREFIX = "discord-thread:";
const APPLY = process.argv.includes("--apply");
const repos = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const { GITHUB_TOKEN } = process.env;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(url, init = {}, { retried = false } = {}) {
  const res = await fetch(url.startsWith("https://") ? url : `https://api.github.com${url}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if ((res.status === 429 || res.status >= 500) && !retried) {
    await sleep(Number(res.headers.get("retry-after") || "1") * 1000);
    return gh(url, init, { retried: true });
  }
  if (!res.ok) {
    const err = new Error(`${init.method || "GET"} ${url} failed: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// Only follow next-page links that stay on api.github.com, so the token is
// never sent elsewhere.
function nextPage(res) {
  const next = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  if (!next) return null;
  return new URL(next).host === "api.github.com" ? next : null;
}

async function getAll(path) {
  const all = [];
  let url = path;
  while (url) {
    const res = await gh(url);
    all.push(...(await res.json()));
    url = nextPage(res);
  }
  return all;
}

async function cleanRepo(fullName) {
  const labels = (await getAll(`/repos/${fullName}/labels?per_page=100`)).filter((l) =>
    l.name.startsWith(THREAD_LABEL_PREFIX)
  );
  let deletable = 0;
  for (const label of labels) {
    const prs = (
      await getAll(
        `/repos/${fullName}/issues?${new URLSearchParams({ labels: label.name, state: "all", per_page: "100" })}`
      )
    ).filter((i) => i.pull_request);
    const prSummary = prs.length ? prs.map((pr) => `#${pr.number} (${pr.state})`).join(", ") : "no PR";
    if (prs.some((pr) => pr.state === "open")) {
      console.log(`  keep          ${label.name}  ${prSummary}`);
      continue;
    }
    console.log(`  ${APPLY ? "delete      " : "would delete"}  ${label.name}  ${prSummary}`);
    if (APPLY) {
      try {
        await gh(`/repos/${fullName}/labels/${encodeURIComponent(label.name)}`, { method: "DELETE" });
      } catch (err) {
        if (err.status !== 404) throw err; // already gone
      }
    }
    deletable++;
  }
  console.log(
    `${fullName}: ${labels.length} thread labels, ${deletable} ${APPLY ? "deleted" : "to delete"}`
  );
}

async function main() {
  if (!GITHUB_TOKEN) throw new Error("Set GITHUB_TOKEN (e.g. GITHUB_TOKEN=$(gh auth token)).");
  if (repos.length === 0) throw new Error("Pass one or more owner/repo arguments.");
  if (!APPLY) console.log("Print-only run. Pass --apply to delete.\n");
  for (const fullName of repos) {
    console.log(fullName);
    await cleanRepo(fullName);
    console.log("");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
