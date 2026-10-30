# standup-core

Drafts a morning standup from what your git repos and their hosts say you did.
It's the engine behind [Standby](https://github.com/bretwphillips/standby) and
[Previously](https://github.com/bretwphillips/previously)'s standup; it has no UI
of its own.

```
*Standup — Thu, May 9*

*Yesterday:*
_Checkout https://git.example.com/groups/team/-/epics/3_
• Add the checkout button https://git.example.com/team/shop/-/merge_requests/41
• Reviewed: Cache the price lookups https://git.example.com/team/api/-/merge_requests/17

*Today:*
_Checkout https://git.example.com/groups/team/-/epics/3_
• Add the checkout button https://git.example.com/team/shop/-/merge_requests/41
• Email receipts https://git.example.com/team/shop/-/work_items/44

*Blockers:* none

*Needs review:* none
```

- **Yesterday** is what the last working day produced: your commits on each
  ticket branch, tickets and merge requests you commented on, merge requests
  you approved. Monday looks back to Friday.
- **Today** is the tickets in play, then your open tickets and the next ones
  nobody has taken in the epics you're working in, filled up to a weight limit
  (GitLab weight; a ticket with none counts as 1). A ticket closed or landed
  stays off it, and one blocked by an open ticket waits for its blocker.
- **Blockers** are your tickets held up by open work that's someone else's.
- **Needs review** is your merge requests marked ready.

Lines are grouped under their epic (on GitHub, the parent issue).

## How it knows

Branches are named `<ticket>-<words>`, as GitLab and GitHub name them when you
start a branch from an issue: `31-login-form` is #31. Everything else comes
from two places:

- **The clones on disk**, read with git. Nothing touches the network.
- **A sync** with each host, through its own command-line tool: `glab` for
  GitLab, `gh` for GitHub, each already logged in. It asks only for what changed
  since the last sync and keeps the rest in a cache.

Only repos on the host most of them share are reported, so a side project
elsewhere stays out; a branch whose commits are all someone else's is left out
too.

## Use

Node 20 or newer, no dependencies.

```sh
npm install github:bretwphillips/standup-core
```

```js
import { findRepos, sync, draft } from "standup-core";

const repos = findRepos(`${process.env.HOME}/Projects`); // a folder of clones, or one clone
const dataDir = `${process.env.HOME}/.my-tool`;          // where the cache lives

await sync({ repos, dataDir });                          // { gitlab: "ok", github: "none" }
const { text } = await draft({ repos, dataDir, weightLimit: 5 });
console.log(text);                                       // Slack-flavoured markdown
```

`sync` options: `quick` (only what's new and review requests), `full` (ask for
everything again), `watch` (`["repo#12"]`, tickets whose state should be known).
Each host reports `"ok"`, `"failed"`, `"missing"` (its tool isn't installed) or
`"none"` (no repos on it).

`draft` options:

- `weightLimit`: how much Today holds (default 5).
- `standup`: `"host"` (default) reports repos on the shared host; `"all"`, every one.
- `reported`: `{ repoName: true | false }` to override that per repo.
- `written`: threads written by hand, by repo name, which win over derived ones:
  `{ shop: [{ ticket: "#12", goal: "Ship the button behind a flag", blocked: ["Waiting on design"] }] }`.
  Each can carry `title`, `goal`, `epic` (`{ ref, title, url }`), `kind: "review"`,
  `blocked` (free-text lines for Blockers), `mrs`, `endedAt`.
- `tasks`: `{ global: [...], repos: { name: [...] } }` of `{ text, done, doneAt }`;
  ones finished in the window are Yesterday.
- `now`: the moment to draft for.

`toHTML(text)` turns the draft into HTML for the clipboard's rich half: Slack
takes that flavour of a paste, so links arrive as clickable `!41` and `#44`
rather than full addresses, and bullets as a real list.

The lower-level pieces (`scanRepo`, `assemble`, `standup`, `syncGitLab`,
`syncGitHub`, `readActivity`) are exported for callers that already have some of
the data.

## Test

```sh
npm test
```

## License

MIT
