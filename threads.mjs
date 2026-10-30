// Turns scanned clones and synced activity into what the standup reads: each
// repo's threads -- one per ticket in play -- and whether the repo is reported.
// Threads written by hand (a goal, an epic, a blocker) win over derived ones;
// with none written, ticket branches and the tickets they name are enough.

const STALE_DAYS = 30;
const finishedMr = (m) => m.state === "merged" || m.state === "closed";

// Still within n working days of a moment (seconds): to the end of the nth weekday
// after it, so Friday's work is still around on Wednesday, not gone by Monday.
const withinWorkingDays = (at, n, now) => {
  const until = new Date(at * 1000);
  for (let added = 0; added < n; ) {
    until.setDate(until.getDate() + 1);
    if (until.getDay() !== 0 && until.getDay() !== 6) added += 1;
  }
  until.setHours(23, 59, 59, 999);
  return now.getTime() <= until.getTime();
};

// On a ticket branch is active unless it has gone quiet; on the default branch is
// clean. A caller that knows more (uncommitted work, say) can pass its own.
export const groupOf = (repo) =>
  repo.isDefault ? "clean" : repo.days !== null && repo.days > STALE_DAYS ? "parked" : "active";

/**
 * scanned: what git.mjs's scanRepo returned, one per repo.
 * activity: the synced activity (activity.mjs's readActivity).
 * written: hand-written threads by repo name, each { ticket, title, goal, epic,
 *   weight, kind, blocked, mrs, endedAt, plan } -- all optional.
 * standup: "host" reports repos on the host most of them share; "all" every repo.
 * reported: repo name -> true/false, overriding that rule per repo.
 */
export function assemble(scanned, activity = {}, { written = {}, standup = "host", reported = {}, group = groupOf, now = new Date() } = {}) {
  const repos = scanned.map((repo) => {
    const name = repo.name;
    const synced = (activity.mrs ?? []).filter((m) => m.repo === name);
    const mrsAt = activity.mrsFetchedAt ?? activity.fetchedAt;
    const syncedOn = mrsAt ? new Date(mrsAt * 1000).toISOString().slice(0, 10) : null;
    // MR state from the sync wins over what was written, being newer.
    const withSynced = (ticket, recorded = []) => {
      const mine = synced.filter((m) => m.ticket === ticket);
      if (!mine.length) return recorded;
      const fresh = mine.map((m) => ({ number: m.number, state: m.state, seenAt: syncedOn, doneAt: m.doneAt ?? null }));
      return [...recorded.filter((r) => !mine.some((m) => m.number === r.number)), ...fresh];
    };
    const issueOf = (ticket) => (activity.issues ?? []).find((i) => i.repo === name && i.ticket === ticket);

    // A ticket branch nobody has written about still gets a thread, titled from
    // the ticket when the sync has seen it and from the branch name when not.
    // Work you committed to in the last few days stays even once it lands --
    // yesterday's merge belongs in today's standup. Older landed work is gone.
    const own = written[name] ?? [];
    const covered = new Set(own.map((t) => t.ticket ?? repo.ticket).filter(Boolean));
    const committedLately = (ticket) =>
      (repo.ticketCommits?.[ticket] ?? []).some((at) => withinWorkingDays(at, 3, now));
    const candidates = new Map((repo.activeTickets ?? []).map((b) => [b.ticket, b]));
    for (const [ticket, branch] of Object.entries(repo.ticketBranches ?? {}))
      if (!candidates.has(ticket) && committedLately(ticket)) candidates.set(ticket, { ticket, branch, title: null });
    const auto = [...candidates.values()]
      .filter((b) => !covered.has(b.ticket))
      .filter((b) => {
        if (b.branch === repo.branch || committedLately(b.ticket)) return true;
        const mrs = synced.filter((m) => m.ticket === b.ticket);
        return !(mrs.length && mrs.every(finishedMr));
      })
      .map((b) => ({ ticket: b.ticket, title: issueOf(b.ticket)?.title ?? b.title, auto: true }));

    const all = [...own.map((t) => ({ ...t })), ...auto];
    const placeholder = repo.ticket && issueOf(repo.ticket)?.title ? { title: issueOf(repo.ticket).title } : {};
    const threads = (all.length ? all : [placeholder]).map((thread) => {
      const ticket = thread.ticket ?? repo.ticket;
      const fromSync = ticket ? issueOf(ticket) : null;
      return {
        ...thread,
        title: thread.title ?? fromSync?.title,
        ticket,
        mrs: withSynced(ticket, thread.mrs),
        plan: (thread.plan ?? []).map((e) => (typeof e === "string" ? { text: e } : e)),
        // Weight and epic from the ticket itself, unless written.
        weight: fromSync?.weight != null ? { value: fromSync.weight } : thread.weight,
        epic: thread.epic ?? fromSync?.epic ?? null,
      };
    });

    // Finished threads fall away three working days after they land. The branch
    // you are on always stays, and a repo never loses its last thread.
    const ended = (thread) => {
      if (thread.endedAt) return Date.parse(thread.endedAt) / 1000;
      const mrs = thread.mrs ?? [];
      if (!mrs.length || !mrs.every(finishedMr)) return null;
      const seen = mrs.map((m) => m.doneAt ?? Date.parse(m.seenAt ?? "") / 1000).filter(Number.isFinite);
      return seen.length ? Math.max(...seen) : null;
    };
    const live = threads.filter((t) => {
      if (t.ticket === repo.ticket) return true;
      const at = ended(t);
      return at === null || withinWorkingDays(at, 3, now);
    });
    const kept = live.length ? live : threads.slice(-1);

    return {
      ...repo,
      threads: kept,
      // The one you are checked out on leads.
      currentIndex: Math.max(0, kept.findIndex((t) => t.ticket && t.ticket === repo.ticket)),
      commentsOn: activity.comments?.[name] ?? {},
      group: group(repo),
    };
  });

  // Whichever host most of your repos live on is work; anything else is yours.
  // Self-configuring, so a side project on another host is left out without
  // naming any host.
  const workHost = (() => {
    const tally = new Map();
    for (const r of repos) if (r.host) tally.set(r.host, (tally.get(r.host) ?? 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  })();
  for (const repo of repos) {
    const onWorkHost = standup === "all" || (workHost ? repo.host === workHost : Boolean(repo.web));
    // Someone else's branch is not yours to report, however much work is on it.
    // Reviewing is your work whoever owns the branch, so comments and approvals
    // only need the repo to be a work repo.
    repo.onWorkHost = onWorkHost;
    repo.inStandup = reported[repo.name] ?? (onWorkHost && repo.branchAuthor === null);
  }
  // Moving work first, newest commit first: the order the standup lists it in.
  const order = { active: 0, parked: 1, clean: 2 };
  return repos.sort((a, b) => (order[a.group] ?? 3) - (order[b.group] ?? 3) || (b.committedAt || 0) - (a.committedAt || 0));
}
