// What the standup needs from a clone on disk. Nothing here touches the
// network -- no fetch, no remote lookups -- so it stays correct offline.
import { execFile } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const DAY = 86400;

async function git(repo, args) {
  try {
    const { stdout } = await run("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** The repos in a folder: the folder itself when it is one, else each of its
    subfolders that is. Hidden ones count, so a tool kept in a dot-folder does. */
export function findRepos(folder) {
  if (existsSync(join(folder, ".git"))) return [{ name: basename(folder), path: folder }];
  let entries = [];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && existsSync(join(folder, e.name, ".git")))
    .map((e) => ({ name: e.name, path: join(folder, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** You, as a repo commits: a repo can set its own email (a personal project
    committing as a GitHub address while the global one is work's). */
export async function authorOf(path) {
  return (await git(path, ["config", "--get", "user.email"])) ?? "";
}

// The branch a repo integrates into: whatever origin/HEAD names, else main or
// master as they exist.
async function defaultBase(repo) {
  const head = await git(repo, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (await git(repo, ["rev-parse", "--verify", "-q", ref])) return ref;
  }
  return "HEAD";
}

export async function scanRepo({ name, path }, author) {
  const repo = path;
  const base = await defaultBase(repo);
  const by = author ? [`--author=${author}`] : [];

  const [branch, last, remote, yours, authors, recent, branchRows] = await Promise.all([
    git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(repo, ["log", "-1", "--format=%ct"]),
    git(repo, ["config", "--get", "remote.origin.url"]),
    git(repo, ["rev-list", "--count", ...by, `${base}..HEAD`]),
    git(repo, ["log", "--format=%an", `${base}..HEAD`]),
    git(repo, ["log", "--since=7.days", ...by, "--format=%ct%x1f%s"]),
    git(repo, [
      "for-each-ref", "refs/heads", "--sort=-committerdate",
      "--format=%(refname:short)%1f%(committerdate:unix)%1f%(upstream)%1f%(upstream:track)",
    ]),
  ]);
  const rows = (branchRows || "").split("\n").filter(Boolean).map((row) => row.split("\x1f"));

  // Your commits on every ticket branch touched this past week, not just the
  // one checked out: a day spent on three branches is three tickets of work.
  // Merging master in counts only on a branch you also committed to this week:
  // getting it ready to land is work, catching up a long-landed one is not.
  const weekAgo = Date.now() / 1000 - 8 * DAY;
  const ticketCommits = {};
  const ticketBranches = {};
  await Promise.all(
    rows
      .filter(([b, at]) => Number(at) >= weekAgo && ticketFrom(b))
      .map(async ([b]) => {
        const log = await git(repo, ["log", "--since=8.days", ...by, "--format=%ct %P", `${base}..${b}`]);
        const commits = (log || "").split("\n").filter(Boolean)
          .map((row) => row.split(" ")).map(([at, ...parents]) => ({ at: Number(at), merge: parents.length > 1 }));
        const list = commits.some((c) => !c.merge) ? commits.map((c) => c.at) : [];
        if (list.length) {
          ticketCommits[ticketFrom(b)] = [...(ticketCommits[ticketFrom(b)] ?? []), ...list];
          ticketBranches[ticketFrom(b)] = b;
        }
      }),
  );

  const branchName = branch || "(detached)";
  const committedAt = Number(last) || 0;
  const web = webBase(remote);

  return {
    name,
    path,
    branch: branchName,
    isDefault: branchName === "master" || branchName === "main",
    web,
    host: web?.split("/")[2] ?? null,
    // Whose branch this is. A branch with no commits of its own is yours by
    // default -- you checked it out to start something.
    branchAuthor: (() => {
      const names = (authors || "").split("\n").filter(Boolean);
      if (!names.length || Number(yours) > 0) return null;
      const tally = new Map();
      for (const n of names) tally.set(n, (tally.get(n) ?? 0) + 1);
      return [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    })(),
    recentCommits: (recent || "").split("\n").filter(Boolean).map((row) => {
      const [at, subject] = row.split("\x1f");
      return { at: Number(at) || 0, subject: subject || "" };
    }),
    ticketCommits,
    ticketBranches,
    // Ticket branches in play: the one you are on, and any touched in the last
    // two weeks whose remote still exists.
    activeTickets: rows
      .filter(([b, at, , track]) =>
        ticketFrom(b) && (b === branchName || (Number(at) >= Date.now() / 1000 - 14 * DAY && !/gone/.test(track))))
      .map(([b, at]) => ({ ticket: ticketFrom(b), branch: b, title: titleFrom(b), at: Number(at) || 0 })),
    committedAt,
    days: committedAt ? Math.floor((Date.now() / 1000 - committedAt) / DAY) : null,
    ticket: ticketFrom(branchName),
    branchTitle: titleFrom(branchName),
  };
}

// origin as a browsable URL: git@host:group/project.git and the https form both
// reduce to https://host/group/project.
export function webBase(remote) {
  if (!remote) return null;
  const ssh = /^(?:ssh:\/\/)?[^@]+@([^:/]+)[:/](.+?)(?:\.git)?$/.exec(remote);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = /^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  return https ? `https://${https[1]}/${https[2]}` : null;
}

// Branches are named `<issue>-<kebab-title>`; anything else has no ticket.
export function ticketFrom(branch) {
  const m = /^(\d+)-/.exec(branch ?? "");
  return m ? `#${m[1]}` : null;
}

export function titleFrom(branch) {
  if (!/^\d+-/.test(branch ?? "")) return null;
  const words = branch.replace(/^\d+-/, "").split("-").filter(Boolean);
  return words.length ? words.join(" ").replace(/^./, (c) => c.toUpperCase()) : null;
}
