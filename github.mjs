// The GitHub half of a sync, through gh, for repos on github.com: the same
// things as gitlab.mjs, written in the same activity shape so the standup treats
// both hosts alike. Pull requests are "!" refs here, as merge requests are on
// GitLab, so a "#" is always an issue. A parent issue stands in for an epic.
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { since as standupSince } from "./standup.mjs";
import { blockersIn } from "./blockers.mjs";

const DAY = 86400;
const VERSION = 1;
const EVENT_DAYS = 21;
const PR_DAYS = 14;
const BRANCH_DAYS = 14;
const MAX_ISSUES = 60;

const readJson = (path, fallback) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
};
const writeAtomic = (path, text) => { writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); };
const secondsOf = (stamp) => Date.parse(stamp) / 1000;
const git = (dir, ...args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const slugOf = (url) => /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url ?? "")?.[1]?.toLowerCase() ?? null;

/**
 * repos: [{ name, path }]; dataDir: where the cache and activity-github.json live;
 * watch: ["repo#12", ...] issues whose state should be known.
 * Returns the activity, or null when there's nothing on GitHub or it didn't answer.
 */
export async function syncGitHub({ repos: list, dataDir, quick = false, full: wantFull = false, watch = [] }) {
  mkdirSync(dataDir, { recursive: true });
  const CACHE_FILE = join(dataDir, "cache-github.json");
  const now = Math.floor(Date.now() / 1000);

  // "owner/name" -> the repo's name here.
  const repos = new Map();
  const dirs = new Map();
  for (const { name, path } of list) {
    const slug = slugOf(git(path, "config", "--get", "remote.origin.url"));
    if (slug) { repos.set(slug, name); dirs.set(slug, path); }
  }
  if (!repos.size) return null;

  let calls = 0;
  const gh = (args, input) =>
    new Promise((resolve) => {
      calls += 1;
      const child = execFile("gh", ["api", ...args], { maxBuffer: 64 << 20 }, (err, out) => {
        try { resolve(err && !out ? null : JSON.parse(out)); } catch { resolve(null); }
      });
      if (input) { child.stdin.write(input); child.stdin.end(); }
    });
  const graphql = (query) => gh(["graphql", "--input", "-"], JSON.stringify({ query }));

  let cache = readJson(CACHE_FILE, null);
  const full = !cache || cache.version !== VERSION || wantFull;
  if (full) cache = { version: VERSION, lastAt: 0, events: {}, prs: {}, issues: {}, reviews: [] };
  quick = quick && !full;
  const last = cache.lastAt;

  if (!cache.me) {
    const user = await gh(["user"]);
    if (!user?.login) return null;
    cache.me = user.login;
  }
  const me = cache.me;

  // ---- your events: comments and approvals, newest first, a page or two back to
  // the last sync (or three weeks on a first one).
  const eventsFrom = cache.eventsAt ?? now - EVENT_DAYS * DAY;
  for (let page = 1; page <= 3; page++) {
    const batch = await gh([`users/${me}/events?per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) { if (page === 1) return null; break; }
    let older = false;
    for (const e of batch) {
      const at = secondsOf(e.created_at);
      if (at < eventsFrom - 300) { older = true; continue; }
      const slug = e.repo?.name?.toLowerCase();
      if (!repos.has(slug)) continue;
      const p = e.payload ?? {};
      let kept = null;
      if (e.type === "IssueCommentEvent" && p.action === "created") {
        kept = { kind: p.issue?.pull_request ? "!" : "#", number: p.issue?.number, title: p.issue?.title, length: (p.comment?.body ?? "").length };
      } else if (e.type === "PullRequestReviewCommentEvent") {
        kept = { kind: "!", number: p.pull_request?.number, title: p.pull_request?.title, length: (p.comment?.body ?? "").length };
      } else if (e.type === "PullRequestReviewEvent") {
        kept = { kind: "!", number: p.pull_request?.number, title: p.pull_request?.title, length: (p.review?.body ?? "").length,
          approved: p.review?.state === "approved" };
      }
      if (kept?.number) cache.events[e.id] = { ...kept, slug, at };
    }
    if (older || batch.length < 100) break;
  }
  for (const [id, e] of Object.entries(cache.events)) if (e.at < now - EVENT_DAYS * DAY) delete cache.events[id];
  cache.eventsAt = now;

  // ---- your pull requests and the ones waiting on your review: one query.
  const PR = "number title state isDraft headRefName url updatedAt repository { nameWithOwner }";
  const since = new Date((last ? last - 3600 : now - PR_DAYS * DAY) * 1000).toISOString().slice(0, 10);
  const found = await graphql(`query {
    ${quick ? "" : `mine: search(type: ISSUE, first: 100, query: "is:pr author:${me} updated:>=${since}") { nodes { ... on PullRequest { ${PR} } } }
    open: search(type: ISSUE, first: 100, query: "is:pr is:open author:${me}") { nodes { ... on PullRequest { ${PR} } } }`}
    review: search(type: ISSUE, first: 100, query: "is:pr is:open review-requested:${me}") {
      nodes { ... on PullRequest { number title url repository { nameWithOwner } author { login ... on User { name } } } } }
  }`);
  if (!found?.data) return null;
  const inScope = (pr) => pr?.number && repos.has(pr.repository?.nameWithOwner?.toLowerCase());
  const slugOfPr = (pr) => pr.repository.nameWithOwner.toLowerCase();

  for (const pr of [...(found.data.mine?.nodes ?? []), ...(found.data.open?.nodes ?? [])].filter(inScope)) {
    const slug = slugOfPr(pr);
    cache.prs[`${slug}!${pr.number}`] = {
      slug, number: pr.number, title: pr.title, state: pr.state, draft: pr.isDraft, branch: pr.headRefName, url: pr.url,
      updatedAt: secondsOf(pr.updatedAt),
    };
  }
  for (const [key, pr] of Object.entries(cache.prs)) if (pr.state !== "OPEN" && pr.updatedAt < now - PR_DAYS * DAY) delete cache.prs[key];
  // Open ones no longer in the open list were closed or merged since; drop them
  // unless this sync's "changed since" list already recorded what became of them.
  if (found.data.open) {
    const open = new Set(found.data.open.nodes.filter(inScope).map((pr) => `${slugOfPr(pr)}!${pr.number}`));
    for (const [key, pr] of Object.entries(cache.prs)) if (pr.state === "OPEN" && !open.has(key)) delete cache.prs[key];
  }

  // Review requests: GitHub drops the request once you review, so the list is
  // already "still waiting on you".
  cache.reviews = (found.data.review?.nodes ?? []).filter((pr) => inScope(pr) && pr.author?.login !== me).map((pr) => ({
    repo: repos.get(slugOfPr(pr)), number: pr.number, title: pr.title, who: pr.author?.name || pr.author?.login || "", url: pr.url,
  }));

  // ---- the issues the standup might show
  const wanted = new Map(); // "slug#n" -> { slug, number, at }
  const want = (slug, number, at) => {
    if (!slug || !number || !repos.has(slug)) return;
    const key = `${slug}#${number}`;
    if (!wanted.has(key) || wanted.get(key).at < at) wanted.set(key, { slug, number: Number(number), at });
  };
  for (const [slug, dir] of dirs) {
    const current = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    for (const line of git(dir, "for-each-ref", "refs/heads", "--format=%(refname:short) %(committerdate:unix)").split("\n")) {
      const [branch, at] = line.split(" ");
      const n = /^(\d+)-/.exec(branch ?? "")?.[1];
      if (n && (branch === current || Number(at) >= now - BRANCH_DAYS * DAY)) want(slug, n, Number(at));
    }
  }
  const standupFrom = standupSince(new Date(now * 1000));
  for (const pr of Object.values(cache.prs)) if (pr.updatedAt >= standupFrom) want(pr.slug, /^(\d+)-/.exec(pr.branch ?? "")?.[1], pr.updatedAt);
  for (const e of Object.values(cache.events)) if (e.at >= standupFrom && e.kind === "#") want(e.slug, e.number, e.at);
  const slugOfName = new Map([...repos].map(([slug, name]) => [name, slug]));
  for (const ref of watch) {
    const [, repo, n] = /^([^#]+)#(\d+)$/.exec(ref) ?? [];
    want(slugOfName.get(repo), n, now);
  }
  // Your open issues, started or not -- last, so what you've touched keeps its place under the cap.
  if (!quick) {
    const answer = await graphql(`query { search(query: "is:issue is:open assignee:@me", type: ISSUE, first: 50) {
      nodes { ... on Issue { number repository { nameWithOwner } } } } }`);
    const assigned = answer?.data?.search?.nodes;
    if (Array.isArray(assigned)) cache.assigned = assigned.filter((i) => i?.number).map((i) => ({ slug: i.repository.nameWithOwner.toLowerCase(), number: i.number }));
  }
  const assignedKeys = new Set();
  for (const a of cache.assigned ?? []) {
    if (!repos.has(a.slug)) continue;
    assignedKeys.add(`${a.slug}#${a.number}`);
    want(a.slug, a.number, 0);
  }
  const issues = [...wanted.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ISSUES);
  if (!quick) {
    const keep = new Set(issues.map((t) => `${t.slug}#${t.number}`));
    for (const key of Object.keys(cache.issues)) if (!keep.has(key)) delete cache.issues[key];
  }

  // "#12" in the same repo, "api#12" in another.
  const refIn = (slug, item) => (item.repository.nameWithOwner.toLowerCase() === slug ? `#${item.number}` : `${item.repository.name}#${item.number}`);

  // One query for all of them; a number that turns out to be a pull request is
  // left alone. "Blocked by" links are newer than some GitHub installs, so a
  // query refused for them is asked again without.
  const asking = quick ? issues.filter((t) => !cache.issues[`${t.slug}#${t.number}`]) : issues;
  if (asking.length) {
    const bySlug = new Map();
    for (const t of asking) (bySlug.get(t.slug) ?? bySlug.set(t.slug, []).get(t.slug)).push(t.number);
    const ask = (deps) => graphql(`query { ${[...bySlug].map(([slug, numbers], i) => {
      const [owner, name] = slug.split("/");
      return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${numbers.map((n) =>
        `n${n}: issueOrPullRequest(number: ${n}) { ... on Issue { number title state body updatedAt
          ${deps ? `blockedBy(first: 20) { nodes { number state repository { name nameWithOwner } } }
            parent { number title state url repository { name nameWithOwner } }
            subIssues(first: 50) { nodes { number title state updatedAt assignees(first: 1) { totalCount } repository { name nameWithOwner } } }` : ""} } }`).join(" ")} }`;
    }).join(" ")} }`);
    let answer = cache.noDeps ? null : await ask(true);
    if (!answer?.data) { cache.noDeps = Boolean(answer?.errors); answer = await ask(false); }
    [...bySlug].forEach(([slug], i) => {
      for (const issue of Object.values(answer?.data?.[`r${i}`] ?? {})) {
        if (!issue?.number) continue;
        cache.issues[`${slug}#${issue.number}`] = {
          slug, number: issue.number, title: issue.title, state: issue.state, body: issue.body ?? "",
          updatedAt: issue.updatedAt ? secondsOf(issue.updatedAt) : null,
          blockedBy: (issue.blockedBy?.nodes ?? []).filter((b) => b.state === "OPEN").map((b) => refIn(slug, b)),
          parent: issue.parent ? { ref: refIn(slug, issue.parent), title: issue.parent.title, url: issue.parent.url, open: issue.parent.state === "OPEN" } : null,
          children: (issue.subIssues?.nodes ?? []).map((c) => ({ ref: refIn(slug, c), title: c.title, open: c.state === "OPEN",
            assigned: (c.assignees?.totalCount ?? 0) > 0, repo: repos.get(c.repository.nameWithOwner.toLowerCase()) ?? c.repository.name,
            number: c.number, updatedAt: c.updatedAt ? secondsOf(c.updatedAt) : null })),
        };
      }
    });
  }

  // GitHub's event feed leaves titles out, so those still missing are looked up
  // in one query and kept: each title is asked for once.
  cache.titles ??= {};
  for (const pr of Object.values(cache.prs)) cache.titles[`${pr.slug}!${pr.number}`] = pr.title;
  for (const t of Object.values(cache.issues)) cache.titles[`${t.slug}#${t.number}`] = t.title;
  {
    const missing = [...new Set(Object.values(cache.events).filter((e) => !e.title).map((e) => `${e.slug}${e.kind}${e.number}`))]
      .filter((key) => !(key in cache.titles)).slice(0, 60);
    if (missing.length) {
      const bySlug = new Map();
      for (const key of missing) {
        const [, slug, , n] = /^(.*?)([#!])(\d+)$/.exec(key);
        (bySlug.get(slug) ?? bySlug.set(slug, new Set()).get(slug)).add(n);
      }
      const answer = await graphql(`query { ${[...bySlug].map(([slug, numbers], i) => {
        const [owner, name] = slug.split("/");
        return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${[...numbers].map((n) =>
          `n${n}: issueOrPullRequest(number: ${n}) { ... on Issue { number title } ... on PullRequest { number title } }`).join(" ")} }`;
      }).join(" ")} }`);
      [...bySlug].forEach(([slug], i) => {
        for (const item of Object.values(answer?.data?.[`r${i}`] ?? {})) {
          if (!item?.number) continue;
          for (const kind of ["#", "!"]) if (missing.includes(`${slug}${kind}${item.number}`)) cache.titles[`${slug}${kind}${item.number}`] = item.title;
        }
      });
    }
    for (const e of Object.values(cache.events)) e.title ||= cache.titles[`${e.slug}${e.kind}${e.number}`] ?? "";
    const live = new Set(Object.values(cache.events).map((e) => `${e.slug}${e.kind}${e.number}`));
    for (const key of Object.keys(cache.titles)) if (!live.has(key)) delete cache.titles[key];
  }

  const activity = toActivity({ cache, repos, assignedKeys, now });
  writeAtomic(join(dataDir, "activity-github.json"), JSON.stringify(activity, null, 2));
  if (!quick) cache.lastAt = now;
  cache.lastSync = { at: now, full, quick, calls, issues: issues.length };
  writeAtomic(CACHE_FILE, JSON.stringify(cache));
  return activity;
}

// "- [ ] #13" / "- [x] api#14" lines in a description: the children of an issue
// used as an epic before GitHub had sub-issues.
const checklist = (body, here) => [...(body ?? "").matchAll(/^\s*[-*]\s+\[([ xX])\]\s+((?:[\w.\/-]*)#\d+)\b/gm)]
  .map(([, box, raw]) => {
    const [, path, n] = /^(?:(?:[\w.-]+\/)?([\w.-]+))?#(\d+)$/.exec(raw) ?? [];
    return n ? { ref: path && path !== here ? `${path}#${n}` : `#${n}`, open: box === " " } : null;
  })
  .filter(Boolean);

function toActivity({ cache, repos, assignedKeys, now }) {
  const comments = {};
  const approvals = [];
  for (const e of Object.values(cache.events)) {
    const repo = repos.get(e.slug);
    if (e.approved) approvals.push({ repo, iid: e.number, title: e.title ?? "", at: e.at });
    if (!e.length) continue;
    comments[repo] ??= {};
    const entry = (comments[repo][`${e.kind}${e.number}`] ??= { count: 0, longest: 0, last: 0, title: "" });
    entry.count += 1;
    entry.longest = Math.max(entry.longest, e.length);
    entry.last = Math.max(entry.last, e.at);
    entry.title ||= e.title ?? "";
  }

  const urlOf = (issue) => {
    const slug = [...repos].find(([, name]) => name === issue.repo)?.[0];
    return slug ? `https://github.com/${slug}/issues/${issue.ticket.slice(1)}` : null;
  };
  const STATE = (pr) => (pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.draft ? "draft" : "rfr");

  const issues = Object.values(cache.issues).map((t) => {
    const repo = repos.get(t.slug);
    const blockedBy = new Map((t.blockedBy ?? []).map((ref) => [ref, "github"]));
    for (const ref of blockersIn(t.body, repo)) if (!blockedBy.has(ref)) blockedBy.set(ref, "description");
    // A parent stands in as the epic. The makeshift kind -- an issue whose
    // description is a checklist of other issues -- counts as a parent too.
    const listed = checklist(t.body, repo);
    return {
      repo, ticket: `#${t.number}`, title: t.title ?? "", state: t.state === "OPEN" ? "opened" : "closed", weight: null,
      assigned: assignedKeys.has(`${t.slug}#${t.number}`), updatedAt: t.updatedAt ?? null,
      epic: t.parent ? { ...t.parent, source: "GitHub", parent: true } : null,
      children: t.children?.length ? t.children : listed.map(({ ref, open }) => ({ ref, title: "", open })),
      blockedBy: [...blockedBy].map(([ref, source]) => ({ ref, source })),
    };
  });
  // A child named only in its parent's checklist gets that parent as its epic.
  for (const parent of issues) {
    for (const c of parent.children) {
      const [, other, n] = /^([^#]*)#(\d+)$/.exec(c.ref) ?? [];
      const child = issues.find((i) => i.repo === (other || parent.repo) && i.ticket === `#${n}`);
      if (child && !child.epic) child.epic = { ref: parent.repo === child.repo ? parent.ticket : `${parent.repo}${parent.ticket}`,
        title: parent.title, url: urlOf(parent), open: parent.state === "opened", source: "GitHub", parent: true };
      if (child && !c.title) c.title = child.title;
    }
  }

  return {
    fetchedAt: now,
    mrsFetchedAt: now,
    comments,
    approvals,
    mrs: Object.values(cache.prs).map((pr) => {
      const ticket = /^(\d+)-/.exec(pr.branch ?? "")?.[1];
      // a finished PR's last update is when it merged or closed, near enough
      const doneAt = pr.state === "MERGED" || pr.state === "CLOSED" ? pr.updatedAt ?? null : null;
      return ticket ? { repo: repos.get(pr.slug), ticket: `#${ticket}`, number: pr.number, state: STATE(pr), title: pr.title ?? "", doneAt } : null;
    }).filter(Boolean),
    issues,
    // An open parent's open sub-issues, in its order: the standup's next work
    // when your own leaves room, as an epic's tickets are on GitLab.
    epicIssues: Object.values(cache.issues).filter((t) => t.state === "OPEN" && t.children?.length).flatMap((t) =>
      t.children.filter((c) => c.open && c.number).map((c, order) => ({
        repo: c.repo, ticket: `#${c.number}`, title: c.title ?? "", weight: null, assigned: Boolean(c.assigned), order, updatedAt: c.updatedAt ?? null,
        epic: { ref: `#${t.number}`, title: t.title, url: `https://github.com/${t.slug}/issues/${t.number}`, open: true, source: "GitHub", parent: true },
      }))),
    reviews: cache.reviews,
  };
}
