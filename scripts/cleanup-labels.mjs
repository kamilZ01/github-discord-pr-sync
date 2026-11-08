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

async function gh(url, init = {}) {
  const res = await fetch(url.startsWith("https://") ? url : `https://api.github.com${url}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`${init.method || "GET"} ${url} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

async function getAll(path) {
  const all = [];
  let url = path;
  while (url) {
    const res = await gh(url);
    all.push(...(await res.json()));
    url = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return all;
}

async function cleanRepo(fullName) {
  const labels = (await getAll(`/repos/${fullName}/labels?per_page=100`)).filter((l) =>
    l.name.startsWith(THREAD_LABEL_PREFIX)
  );
  let deleted = 0;
  for (const label of labels) {
    const q = new URLSearchParams({ labels: label.name, state: "all", per_page: "100" });
    const prs = (await getAll(`/repos/${fullName}/issues?${q}`)).filter((i) => i.pull_request);
    const open = prs.filter((pr) => pr.state === "open");
    const where = prs.length ? prs.map((pr) => `#${pr.number} (${pr.state})`).join(", ") : "no PR";
    if (open.length > 0) {
      console.log(`  keep    ${label.name}  ${where}`);
      continue;
    }
    console.log(`  ${APPLY ? "delete" : "would delete"}  ${label.name}  ${where}`);
    if (APPLY) {
      await gh(`/repos/${fullName}/labels/${encodeURIComponent(label.name)}`, { method: "DELETE" });
    }
    deleted++;
  }
  console.log(
    `${fullName}: ${labels.length} thread labels, ${deleted} ${APPLY ? "deleted" : "to delete"}`
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
