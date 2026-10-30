// What the standup needs from GitLab that a clone can't see: comments you left,
// merge requests you opened and approved, review requests, and the weight, epic
// and blockers of the tickets you're on. Asked through glab, and kept in a cache
// so a sync asks only for what changed: events and merge requests since the
// last one, and tickets in one call per project. A closed ticket is taken as
// final. `full` asks for everything again.
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { since as standupSince } from "./standup.mjs";
import { refOf, blockersIn } from "./blockers.mjs";

const DAY = 86400;
const VERSION = 1;
const EPIC_EVERY = DAY;
const EVENT_DAYS = 21;
const MR_DAYS = 14;
const BRANCH_DAYS = 14;
const MAX_TICKETS = 60;

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};
const writeAtomic = (path, text) => {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
};
const iso = (seconds) => new Date(seconds * 1000).toISOString();
// The events API filters by whole days, and excludes the day it is given.
const dayBefore = (seconds) => iso(seconds - DAY).slice(0, 10);
const secondsOf = (stamp) => Date.parse(stamp) / 1000;
const git = (dir, ...args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const projectPath = (url) => url.replace(/^[a-z+]+:\/\/[^/]+\//, "").replace(/^[^@]*@[^:]+:/, "").replace(/\.git$/, "");

/**
 * repos: [{ name, path }] -- the clones to report on.
 * host: the GitLab host, e.g. "gitlab.example.com".
 * dataDir: where the cache and activity-gitlab.json live.
 * watch: ["repo#12", ...] tickets whose state should be known, e.g. written blockers.
 * Returns the activity, or null when GitLab didn't answer (the last one stays).
 */
export async function syncGitLab({ repos, host, dataDir, quick = false, full: wantFull = false, watch = [] }) {
  mkdirSync(dataDir, { recursive: true });
  const CACHE_FILE = join(dataDir, "cache-gitlab.json");
  const now = Math.floor(Date.now() / 1000);

  // Each clone on this host: its full project path, and its name here. Two
  // projects can share a last segment, so the repo is found by the whole path.
  const clones = repos
    .map((r) => ({ ...r, url: git(r.path, "config", "--get", "remote.origin.url") }))
    .filter((r) => r.url.includes(host))
    .map((r) => ({ ...r, project: projectPath(r.url) }));
  // glab needs to run inside a repo to resolve its host and token.
  const anchor = clones[0]?.path;
  if (!anchor) return null;
  const folders = new Map(clones.map((c) => [c.project, c.name]));
  const folderOf = (path = "") => folders.get(path) ?? path.split("/").pop();

  let cache = readJson(CACHE_FILE, null);
  const full = !cache || cache.version !== VERSION || wantFull;
  if (full) cache = { version: VERSION, lastAt: 0, events: {}, mrs: {}, issues: {}, epics: {}, projects: {} };
  const last = cache.lastAt;
  quick = quick && !full;
  const eventsLast = cache.eventsAt ?? last;

  let calls = 0;
  const api = (path) =>
    new Promise((resolve) => {
      calls += 1;
      execFile("glab", ["api", path], { cwd: anchor, maxBuffer: 64 << 20 }, (err, out) => {
        try {
          resolve(err ? null : JSON.parse(out));
        } catch {
          resolve(null);
        }
      });
    });
  // A list endpoint, page by page until a short page; a few pages at most.
  const pages = async (path, most = 5) => {
    const all = [];
    for (let page = 1; page <= most; page++) {
      const batch = await api(`${path}&per_page=100&page=${page}`);
      if (!Array.isArray(batch)) return page === 1 ? null : all;
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  };

  // ---- your projects: each clone looked up once by its path, for the id
  // GitLab's events and merge requests name it by. Ids never change.
  const lookUp = async (ref) => {
    const p = await api(`projects/${encodeURIComponent(ref)}`);
    if (p?.id) cache.projects[p.id] = { id: p.id, path: p.path_with_namespace };
  };
  const known = new Set(Object.values(cache.projects).map((p) => p.path));
  if (!quick) await Promise.all(clones.map((c) => c.project).filter((p) => !known.has(p)).map(lookUp));

  // ---- events and merge requests: only what came since the last sync
  const eventsCall = pages(`events?after=${eventsLast ? dayBefore(eventsLast) : dayBefore(now - EVENT_DAYS * DAY)}`);
  const mrsCall = quick ? Promise.resolve(null) : pages(
    `merge_requests?scope=created_by_me&state=all&updated_after=${iso(last ? last - 3600 : now - MR_DAYS * DAY)}`,
  );
  if (!cache.user?.username) {
    const user = await api("user");
    if (user?.username) cache.user = { id: user.id, username: user.username };
  }
  const reviewsCall = cache.user?.username
    ? pages(`merge_requests?scope=all&state=opened&reviewer_username=${encodeURIComponent(cache.user.username)}`)
    : Promise.resolve(null);
  // Your open tickets, started or not, so the standup can plan past what you've begun.
  const assignedCall = quick ? Promise.resolve(null) : pages("issues?scope=assigned_to_me&state=opened");
  const [newEvents, newMrs, reviewing, assignedIssues] = await Promise.all([eventsCall, mrsCall, reviewsCall, assignedCall]);
  // Without events GitLab didn't answer; leave everything as it was, so the next
  // sync still asks from the last good one.
  if (!newEvents) return null;
  if (assignedIssues) cache.assigned = assignedIssues.map((i) => ({ project_id: i.project_id, iid: i.iid }));

  for (const e of newEvents) {
    cache.events[e.id] = {
      id: e.id,
      project_id: e.project_id,
      action_name: e.action_name,
      created_at: e.created_at,
      target_iid: e.target_iid,
      target_title: e.target_title,
      // Only its length is read: a long comment counts as work on its own.
      note: e.note ? { noteable_type: e.note.noteable_type, noteable_iid: e.note.noteable_iid, length: (e.note.body ?? "").length } : null,
    };
  }
  for (const [id, e] of Object.entries(cache.events)) if (secondsOf(e.created_at) < now - EVENT_DAYS * DAY) delete cache.events[id];

  // A merge request you approved is review work even in a project not cloned
  // here: each such project is looked up (by id) once, for the path its link needs.
  await Promise.all(
    [...new Set(Object.values(cache.events).filter((e) => e.action_name === "approved").map((e) => e.project_id))]
      .filter((id) => !cache.projects[id])
      .map((id) => lookUp(id)),
  );

  for (const m of newMrs ?? []) {
    cache.mrs[m.id] = {
      id: m.id, iid: m.iid, project_id: m.project_id, source_branch: m.source_branch, references: { full: m.references?.full },
      state: m.state, draft: m.draft, title: m.title, updated_at: m.updated_at, merged_at: m.merged_at, closed_at: m.closed_at,
    };
  }
  for (const [id, m] of Object.entries(cache.mrs)) if (secondsOf(m.updated_at) < now - MR_DAYS * DAY) delete cache.mrs[id];

  // Review requests: someone else's, open, not yet approved by you.
  if (Array.isArray(reviewing)) {
    const approvedIds = new Set(
      Object.values(cache.events).filter((e) => e.action_name === "approved").map((e) => `${e.project_id}!${e.target_iid}`),
    );
    cache.reviews = reviewing
      .filter((m) => m.author?.username !== cache.user.username && !approvedIds.has(`${m.project_id}!${m.iid}`))
      .map((m) => ({ iid: m.iid, path: (m.references?.full ?? "").split("!")[0], title: m.title,
        who: m.author?.name ?? m.author?.username ?? "", url: m.web_url }));
  }

  // ---- the tickets the standup might show
  const projects = Object.values(cache.projects);
  const pathOf = new Map(projects.map((p) => [p.id, p.path]));
  const wanted = new Map(); // "path#iid" -> { path, iid, at }
  const want = (path, iid, at) => {
    if (!path || !iid) return;
    const key = `${path}#${iid}`;
    if (!wanted.has(key) || wanted.get(key).at < at) wanted.set(key, { path, iid: Number(iid), at });
  };
  // The branch you are on, and ticket branches touched in the last two weeks --
  // merged ones too, since yesterday's merge is still yesterday's work.
  for (const c of clones) {
    const current = git(c.path, "rev-parse", "--abbrev-ref", "HEAD");
    for (const line of git(c.path, "for-each-ref", "refs/heads", "--format=%(refname:short) %(committerdate:unix)").split("\n")) {
      const [branch, at] = line.split(" ");
      const iid = /^(\d+)-/.exec(branch ?? "")?.[1];
      if (iid && (branch === current || Number(at) >= now - BRANCH_DAYS * DAY)) want(c.project, iid, Number(at));
    }
  }
  // Tickets your merge requests name, and tickets you commented on, in the standup's window.
  const standupFrom = standupSince(new Date(now * 1000));
  for (const m of Object.values(cache.mrs)) {
    const at = secondsOf(m.updated_at);
    if (at >= standupFrom) want(pathOf.get(m.project_id), /^(\d+)-/.exec(m.source_branch ?? "")?.[1], at);
  }
  for (const e of Object.values(cache.events)) {
    const at = secondsOf(e.created_at);
    if (at >= standupFrom && e.action_name === "commented on" && e.note?.noteable_type === "Issue") {
      want(pathOf.get(e.project_id), e.note.noteable_iid, at);
    }
  }
  // Tickets you're watching, such as written blockers: only their state is needed.
  const stateOnly = new Set();
  const pathOfFolder = new Map(clones.map((c) => [c.name, c.project]));
  for (const ref of watch) {
    const [, repo, iid] = /^([^#]+)#(\d+)$/.exec(ref) ?? [];
    const path = pathOfFolder.get(repo);
    if (!iid || !path) continue;
    if (!wanted.has(`${path}#${iid}`)) stateOnly.add(`${path}#${iid}`);
    want(path, iid, now);
  }
  // Your open tickets last: what you've touched keeps its place under the cap.
  const assignedKeys = new Set();
  for (const a of cache.assigned ?? []) {
    const path = pathOf.get(a.project_id);
    if (!path) continue;
    assignedKeys.add(`${path}#${a.iid}`);
    want(path, a.iid, 0);
  }
  const tickets = [...wanted.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_TICKETS);
  const keep = new Set(tickets.map(([key]) => key));
  if (!quick) for (const key of Object.keys(cache.issues)) if (!keep.has(key)) delete cache.issues[key];

  // One call per project. A ticket not seen before means asking for all of them;
  // otherwise only those changed since the last sync come back.
  const byProject = new Map();
  for (const [key, t] of tickets) {
    if (!byProject.has(t.path)) byProject.set(t.path, []);
    byProject.get(t.path).push({ key, iid: t.iid });
  }
  const changed = new Set();
  await Promise.all(
    [...byProject].map(async ([path, list]) => {
      const unseen = list.filter((t) => !cache.issues[t.key]);
      const open = list.filter((t) => cache.issues[t.key] && cache.issues[t.key].issue.state !== "closed");
      const ask = quick ? unseen : [...unseen, ...open];
      if (!ask.length) return;
      const query = ask.map((t) => `iids[]=${t.iid}`).join("&");
      const since = unseen.length ? "" : `&updated_after=${iso(last - 300)}`;
      const found = await api(`projects/${encodeURIComponent(path)}/issues?${query}${since}&per_page=100`);
      for (const issue of Array.isArray(found) ? found : []) {
        const key = `${path}#${issue.iid}`;
        cache.issues[key] = {
          path,
          links: cache.issues[key]?.links ?? null,
          issue: {
            iid: issue.iid, title: issue.title, state: issue.state, weight: issue.weight, description: issue.description,
            updated_at: issue.updated_at,
            epic: issue.epic ? { iid: issue.epic.iid, group_id: issue.epic.group_id, title: issue.epic.title, url: issue.epic.url } : null,
          },
        };
        changed.add(key);
      }
    }),
  );

  // Links say what blocks a ticket. Each is asked once; after that, only open
  // tickets again -- those that changed, and those already blocked, since a
  // blocker closing doesn't touch the ticket it blocked.
  if (!quick) await Promise.all(
    tickets.map(async ([key, t]) => {
      const entry = cache.issues[key];
      if (!entry || stateOnly.has(key) || (entry.links && entry.issue.state === "closed")) return;
      const blocked = (entry.links ?? []).some((l) => l.link_type === "is_blocked_by" && l.state !== "closed");
      if (!changed.has(key) && entry.links && !blocked) return;
      const links = await api(`projects/${encodeURIComponent(t.path)}/issues/${t.iid}/links`);
      if (Array.isArray(links)) {
        // Who has each linked ticket: Blockers only lists work that's someone else's.
        entry.links = links.map((l) => ({ link_type: l.link_type, state: l.state, iid: l.iid, references: { full: l.references?.full },
          assignees: (l.assignees ?? []).map((a) => a.username) }));
      }
    }),
  );

  // Each epic those tickets belong to, for whether it is still open and its
  // address: looked up at most once a day. Then its open tickets, in the epic's
  // own order, so the standup can pick up the next one nobody has started.
  const epicKeys = new Map();
  for (const [key] of tickets) {
    const e = cache.issues[key]?.issue.epic;
    if (e?.group_id && e.iid) epicKeys.set(`${e.group_id}-${e.iid}`, e);
  }
  if (!quick) {
    await Promise.all(
      [...epicKeys].map(async ([key, e]) => {
        if (cache.epics[key] && now - cache.epics[key].fetchedAt < EPIC_EVERY) return;
        const epic = await api(`groups/${e.group_id}/epics/${e.iid}`);
        if (epic?.iid) {
          cache.epics[key] = {
            fetchedAt: now,
            epic: { iid: epic.iid, group_id: epic.group_id, title: epic.title, web_url: epic.web_url, state: epic.state },
          };
        }
      }),
    );
    for (const key of Object.keys(cache.epics)) if (!epicKeys.has(key)) delete cache.epics[key];
    await Promise.all(
      Object.values(cache.epics).map(async (c) => {
        if (c.epic.state === "closed") { c.issues = []; return; }
        const list = await pages(`groups/${c.epic.group_id}/epics/${c.epic.iid}/issues?state=opened`);
        if (Array.isArray(list)) {
          c.issues = list.filter((i) => i.state === "opened").map((i, order) => ({
            project_id: i.project_id, iid: i.iid, title: i.title, weight: i.weight ?? null, assigned: (i.assignees ?? []).length > 0, order,
            updatedAt: i.updated_at ? secondsOf(i.updated_at) : null,
          }));
        }
      }),
    );
  }

  // Who you are comes from your own events: a blocker of yours isn't "someone else's".
  cache.me = newEvents.find((e) => e.author_username)?.author_username ?? cache.me ?? cache.user?.username;
  const activity = toActivity({ cache, folderOf, folders, host, tickets, assignedKeys, me: cache.me, now });
  writeAtomic(join(dataDir, "activity-gitlab.json"), JSON.stringify(activity, null, 2));

  cache.eventsAt = now;
  if (!quick) cache.lastAt = now;
  cache.lastSync = { at: now, full, quick, calls, tickets: tickets.length };
  writeAtomic(CACHE_FILE, JSON.stringify(cache));
  return activity;
}

// The cache, as the activity the standup reads: comments and approvals by repo,
// merge requests by ticket, tickets with their weight, epic and blockers.
function toActivity({ cache, folderOf, folders, host, tickets, assignedKeys, me, now }) {
  const pathOf = new Map(Object.values(cache.projects).map((p) => [p.id, p.path]));

  const comments = {};
  const approvals = [];
  for (const event of Object.values(cache.events).sort((a, b) => b.id - a.id)) {
    const path = pathOf.get(event.project_id);
    if (!path) continue;
    const repo = folderOf(path);
    const at = secondsOf(event.created_at);
    // One in a project not cloned here keeps its own link, rather than a repo's.
    if (event.action_name === "approved") {
      const cloned = folders.has(path);
      approvals.push({
        repo: cloned ? repo : null,
        ...(cloned ? {} : { web: `https://${host}/${path}` }),
        iid: event.target_iid,
        title: event.target_title ?? "",
        at,
      });
      continue;
    }
    if (event.action_name !== "commented on" || !event.note) continue;
    const { noteable_type: kind, noteable_iid: iid, length = 0 } = event.note;
    if (kind !== "Issue" && kind !== "MergeRequest") continue;
    const key = `${kind === "Issue" ? "#" : "!"}${iid}`;
    comments[repo] ??= {};
    const entry = (comments[repo][key] ??= { count: 0, longest: 0, last: 0, title: "" });
    entry.count += 1;
    entry.longest = Math.max(entry.longest, length);
    entry.last = Math.max(entry.last, at);
    entry.title ||= event.target_title ?? "";
  }

  // Your merge requests, keyed to a ticket by the number their source branch
  // starts with ("31-login-form-..." is #31).
  const STATE = (mr) =>
    mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : mr.draft ? "draft" : "rfr";
  const mrs = Object.values(cache.mrs)
    .map((mr) => {
      const ticket = /^(\d+)-/.exec(mr.source_branch ?? "")?.[1];
      const repo = folderOf((mr.references?.full ?? "").split("!")[0]);
      return ticket && repo
        ? { repo, ticket: `#${ticket}`, number: mr.iid, state: STATE(mr), title: mr.title ?? "",
            doneAt: STATE(mr) === "merged" || STATE(mr) === "closed"
              ? Date.parse(mr.merged_at ?? mr.closed_at ?? mr.updated_at ?? "") / 1000 || null
              : null }
        : null;
    })
    .filter(Boolean);

  // Epics looked up on their own: open or closed, and their real address. Without
  // a lookup (no epics on the tier) an epic counts as open, at the ticket's path.
  const epics = new Map(Object.values(cache.epics).map((c) => [`${c.epic.group_id}/${c.epic.iid}`, c.epic]));
  const epicOf = (e) => {
    const found = epics.get(`${e.group_id}/${e.iid}`);
    return {
      ref: `&${e.iid}`,
      title: found?.title ?? e.title ?? "",
      url: found?.web_url ?? (e.url ? `https://${host}${e.url}` : null),
      open: found ? found.state !== "closed" : true,
    };
  };

  const issues = tickets
    .filter(([key]) => cache.issues[key])
    .map(([key]) => {
      const { path, issue, links } = cache.issues[key];
      const repo = folderOf(path);
      const blockedBy = new Map();
      for (const link of links ?? []) {
        if (link.link_type !== "is_blocked_by" || link.state === "closed") continue;
        const ref = refOf(link.references?.full ?? `#${link.iid}`, repo);
        // others: someone else has it (true), nobody or you (false).
        const who = link.assignees;
        if (ref) blockedBy.set(ref, { source: "gitlab", ...(Array.isArray(who) ? { others: who.length > 0 && !who.includes(me) } : {}) });
      }
      for (const ref of blockersIn(issue.description, repo)) if (!blockedBy.has(ref)) blockedBy.set(ref, { source: "description" });
      return {
        repo,
        ticket: `#${issue.iid}`,
        title: issue.title ?? "",
        state: issue.state ?? null,
        weight: issue.weight ?? null,
        assigned: assignedKeys.has(key),
        updatedAt: issue.updated_at ? Date.parse(issue.updated_at) / 1000 : null,
        epic: issue.epic?.iid ? epicOf(issue.epic) : null,
        blockedBy: [...blockedBy].map(([ref, b]) => ({ ref, ...b })),
      };
    });

  const epicIssues = Object.values(cache.epics).flatMap((c) => (c.issues ?? [])
    .filter((i) => pathOf.get(i.project_id))
    .map((i) => ({
      repo: folderOf(pathOf.get(i.project_id)), ticket: `#${i.iid}`, title: i.title ?? "", weight: i.weight ?? null,
      assigned: Boolean(i.assigned), order: i.order ?? 0, updatedAt: i.updatedAt ?? null,
      epic: epicOf({ iid: c.epic.iid, group_id: c.epic.group_id, title: c.epic.title }),
    })));

  const reviews = (cache.reviews ?? []).map(({ path, iid, title, who, url }) => ({ repo: folderOf(path), number: iid, title: title ?? "", who, url }));

  return { fetchedAt: now, mrsFetchedAt: now, comments, approvals, mrs, issues, epicIssues, reviews };
}
