// A morning standup drafted from what your repos and their hosts say you did:
// Yesterday from commits, comments, approvals and landed work; Today from the
// tickets in play and the next ones in their epics, filled to a weight limit.
//
//   const repos = folders.flatMap(findRepos);
//   await sync({ repos, dataDir });          // GitLab through glab, GitHub through gh
//   const { text } = await draft({ repos, dataDir });
import { readFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { join } from "node:path";
import { findRepos, scanRepo, authorOf, webBase } from "./git.mjs";
import { assemble, groupOf } from "./threads.mjs";
import { standup, since } from "./standup.mjs";
import { syncGitLab } from "./gitlab.mjs";
import { syncGitHub } from "./github.mjs";
import { toHTML } from "./format.mjs";

export { findRepos, scanRepo, assemble, groupOf, standup, since, syncGitLab, syncGitHub, toHTML };

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};

/** Whether a program can be found at all (glab, gh). */
export function has(name) {
  const found = spawnSync(name, ["--version"], { stdio: "ignore", windowsHide: true });
  return !found.error && found.status === 0;
}

const hostOf = (path) => {
  try {
    const remote = execFileSync("git", ["-C", path, "config", "--get", "remote.origin.url"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return webBase(remote)?.split("/")[2] ?? null;
  } catch {
    return null;
  }
};

/** The GitLab the repos' work lives on: whichever host most of them point at,
    leaving github.com to GitHub. */
export function gitlabHost(repos) {
  const counts = {};
  for (const r of repos) {
    const host = hostOf(r.path);
    if (host && host !== "github.com") counts[host] = (counts[host] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Asks each host what a clone can't see, side by side. Each host is skipped
 * when none of the repos are on it, and reported missing when its tool isn't
 * installed. quick: only what's new since the last sync and review requests.
 * full: everything again. watch: ["repo#12"] tickets whose state should be known.
 * Returns { gitlab, github }, each "ok", "failed", "missing" or "none".
 */
export async function sync({ repos, dataDir, quick = false, full = false, watch = [] }) {
  const host = gitlabHost(repos);
  const onGitHub = repos.some((r) => hostOf(r.path) === "github.com");
  const run = async (needed, tool, call) => {
    if (!needed) return "none";
    if (!has(tool)) return "missing";
    return (await call()) ? "ok" : "failed";
  };
  const [gitlab, github] = await Promise.all([
    run(Boolean(host), "glab", () => syncGitLab({ repos, host, dataDir, quick, full, watch })),
    run(onGitHub, "gh", () => syncGitHub({ repos, dataDir, quick, full, watch })),
  ]);
  return { gitlab, github };
}

/** The last sync's activity, both hosts read as one. */
export function readActivity(dataDir) {
  const lab = readJson(join(dataDir, "activity-gitlab.json"), {});
  const hub = readJson(join(dataDir, "activity-github.json"), {});
  const comments = { ...lab.comments };
  for (const [repo, refs] of Object.entries(hub.comments ?? {})) comments[repo] = { ...comments[repo], ...refs };
  const list = (k) => [...(lab[k] ?? []), ...(hub[k] ?? [])];
  const when = (k) => Math.max(lab[k] ?? 0, hub[k] ?? 0) || null;
  return {
    fetchedAt: when("fetchedAt"), mrsFetchedAt: when("mrsFetchedAt"), comments,
    approvals: list("approvals"), mrs: list("mrs"), issues: list("issues"), epicIssues: list("epicIssues"), reviews: list("reviews"),
  };
}

/**
 * The standup, from the repos on disk and the last sync. Reads git afresh each
 * time; never touches the network.
 * written: hand-written threads by repo name (see threads.mjs).
 * tasks: { global: [], repos: {} } of { text, done, doneAt } -- finished ones are Yesterday.
 * standup: "host" (default) or "all"; reported: per-repo overrides.
 */
export async function draft({ repos, dataDir, written, tasks = {}, weightLimit, standup: rule, reported, now = new Date() }) {
  const scanned = await Promise.all(repos.map(async (r) => scanRepo(r, await authorOf(r.path))));
  const activity = readActivity(dataDir);
  const assembled = assemble(scanned, activity, { written, standup: rule, reported, now });
  return { ...standup(assembled, tasks, activity, now, { weightLimit }), repos: assembled, activity };
}
