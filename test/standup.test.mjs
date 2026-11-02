import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble } from "../threads.mjs";
import { standup } from "../standup.mjs";

// Thursday morning; yesterday is Wednesday.
const now = new Date(2030, 4, 9, 9, 0);
const yesterday = new Date(2030, 4, 8, 14, 0).getTime() / 1000;
const lastMonth = new Date(2030, 3, 2, 14, 0).getTime() / 1000;

const repo = (over = {}) => ({
  name: "shop",
  branch: "12-checkout-button",
  isDefault: false,
  web: "https://git.example.com/team/shop",
  host: "git.example.com",
  branchAuthor: null,
  recentCommits: [],
  ticketCommits: {},
  ticketBranches: {},
  activeTickets: [],
  committedAt: yesterday,
  days: 0,
  ticket: "#12",
  branchTitle: "Checkout button",
  ...over,
});

const issue = (ticket, over = {}) => ({
  repo: "shop", ticket, title: `Ticket ${ticket}`, state: "opened", weight: 1, assigned: true, updatedAt: yesterday,
  epic: { ref: "&3", title: "Checkout", url: "https://git.example.com/groups/team/-/epics/3", open: true }, blockedBy: [],
  ...over,
});

const draft = (scanned, activity, opts = {}) => standup(assemble(scanned, activity, { now }), {}, activity, now, opts).text;

test("a ticket branch with yesterday's commits is Yesterday and Today, titled from the ticket", () => {
  const text = draft(
    [repo({ ticketCommits: { "#12": [yesterday] }, ticketBranches: { "#12": "12-checkout-button" },
      activeTickets: [{ ticket: "#12", branch: "12-checkout-button", title: "Checkout button", at: yesterday }] })],
    { issues: [issue("#12", { title: "Add the checkout button" })] },
  );
  const [before, after] = text.split("*Today:*");
  assert.match(before, /Add the checkout button/);
  assert.match(after, /Add the checkout button/);
  assert.match(text, /_Checkout https:\/\/git\.example\.com\/groups\/team\/-\/epics\/3_/);
});

test("a closed ticket is worked on, not planned", () => {
  const text = draft(
    [repo({ branch: "main", isDefault: true, ticket: null, ticketCommits: { "#7": [yesterday] }, ticketBranches: { "#7": "7-receipts" } })],
    { issues: [issue("#7", { title: "Email receipts", state: "closed" })] },
  );
  const [before, after] = text.split("*Today:*");
  assert.match(before, /Email receipts/);
  assert.doesNotMatch(after, /Email receipts/);
});

test("Today fills to the weight limit, carried-over work first", () => {
  const text = draft(
    [repo({ ticketCommits: { "#12": [yesterday] }, ticketBranches: { "#12": "12-checkout-button" } })],
    { issues: [issue("#12", { weight: 3 }), issue("#20", { weight: 3 }), issue("#21", { weight: 2 })] },
    { weightLimit: 5 },
  );
  const after = text.split("*Today:*")[1].split("*Blockers")[0];
  assert.match(after, /Ticket #12/);
  // #20 doesn't fit after #12; the smaller #21 still does.
  assert.doesNotMatch(after, /Ticket #20/);
  assert.match(after, /Ticket #21/);
});

test("repos on another host are left out", () => {
  const work = repo({ ticketCommits: { "#12": [yesterday] }, ticketBranches: { "#12": "12-checkout-button" } });
  const side = repo({ name: "garden", web: "https://github.com/someone/garden", host: "github.com",
    ticketCommits: { "#4": [yesterday] }, ticketBranches: { "#4": "4-seed-list" }, branch: "4-seed-list", ticket: "#4" });
  const third = repo({ name: "api", web: "https://git.example.com/team/api" });
  const repos = assemble([work, side, third], {}, { now });
  assert.equal(repos.find((r) => r.name === "garden").inStandup, false);
  assert.equal(repos.find((r) => r.name === "shop").inStandup, true);
  assert.doesNotMatch(standup(repos, {}, {}, now).text, /Seed list/);
});

test("someone else's branch isn't yours to report", () => {
  const repos = assemble([repo({ branchAuthor: "A. Colleague" })], {}, { now });
  assert.equal(repos[0].inStandup, false);
});

test("a ticket landed weeks ago drops away once its MR is merged", () => {
  const repos = assemble(
    [repo({ branch: "main", isDefault: true, ticket: null,
      activeTickets: [{ ticket: "#5", branch: "5-old-work", title: "Old work", at: lastMonth }] })],
    { mrs: [{ repo: "shop", ticket: "#5", number: 9, state: "merged", doneAt: lastMonth }] },
    { now },
  );
  assert.ok(!repos[0].threads.some((t) => t.ticket === "#5"));
});

test("work on main with no ticket is Yesterday, and doesn't wake an old ticket", () => {
  const scanned = repo({ branch: "main", isDefault: true, ticket: null, recentCommits: [{ at: yesterday, subject: "Fix the footer link" }],
    untracked: [{ at: yesterday, title: "Fix the footer link" }, { at: lastMonth, title: "Something long ago" }] });
  const text = standup(assemble([scanned], {}, { now, written: { shop: [{ ticket: "#5", title: "Old work" }] } }), {}, {}, now).text;
  assert.match(text.split("*Today:*")[0], /Fix the footer link/);
  assert.doesNotMatch(text, /Old work|Something long ago/);
});

test("a repo that merged pull requests is reported by them, not its commits", () => {
  const scanned = repo({ branch: "main", isDefault: true, ticket: null,
    untracked: [{ at: yesterday, title: "Squish fades in" }, { at: yesterday, title: "Squish fades out" }] });
  const text = draft([scanned], { mrs: [{ repo: "shop", ticket: "#30", number: 33, state: "merged", title: "Ground stop", doneAt: yesterday }] });
  assert.match(text, /Ground stop https:\/\/git\.example\.com\/team\/shop\/-\/merge_requests\/33/);
  assert.doesNotMatch(text, /Squish/);
});

test("needs review names who it's waiting on", () => {
  const text = draft([repo()], { mrs: [{ repo: "shop", ticket: "#12", number: 41, state: "rfr", reviewers: ["ana.lima", "sam"] }] });
  assert.match(text.split("*Needs review:*")[1], /merge_requests\/41 \(ana, sam\)/);
});

test("written threads win over derived ones and keep their goal", () => {
  const repos = assemble(
    [repo({ ticketCommits: { "#12": [yesterday] }, activeTickets: [{ ticket: "#12", branch: "12-checkout-button", at: yesterday }] })],
    { issues: [issue("#12")] },
    { now, written: { shop: [{ ticket: "#12", goal: "Ship the checkout button behind a flag" }] } },
  );
  assert.equal(repos[0].threads.length, 1);
  assert.match(standup(repos, {}, {}, now).text, /Ship the checkout button behind a flag/);
});

test("on a Monday, Yesterday is Friday and the weekend, not this morning", () => {
  const monday = new Date(2030, 4, 13, 10, 0);
  const friday = new Date(2030, 4, 10, 15, 0).getTime() / 1000;
  const sunday = new Date(2030, 4, 12, 15, 0).getTime() / 1000;
  const thisMorning = new Date(2030, 4, 13, 9, 0).getTime() / 1000;
  const scanned = [
    repo({ branch: "12-checkout-button", committedAt: thisMorning,
      ticketCommits: { "#12": [friday], "#14": [sunday], "#15": [thisMorning] },
      ticketBranches: { "#12": "12-checkout-button", "#14": "14-receipts", "#15": "15-refunds" },
      activeTickets: [12, 14, 15].map((n) => ({ ticket: `#${n}`, branch: `${n}-x`, title: null, at: thisMorning })) }),
  ];
  const activity = { issues: [issue("#12"), issue("#14"), issue("#15")] };
  const text = standup(assemble(scanned, activity, { now: monday }), {}, activity, monday).text;
  const yesterday = text.split("*Today:*")[0];
  assert.match(yesterday, /Ticket #12/);
  assert.match(yesterday, /Ticket #14/);
  assert.doesNotMatch(yesterday, /Ticket #15/);
  assert.match(text.split("*Today:*")[1], /Ticket #15/);
});

test("a merged request of a ticket's is said as the ticket, under its epic", () => {
  const merged = new Date(2030, 4, 8, 13, 0).getTime() / 1000;
  const activity = {
    issues: [issue("#54", { title: "Home page view", state: "closed" })],
    mrs: [{ repo: "shop", ticket: "#54", number: 83, state: "merged", title: 'Resolve "Home page view"', doneAt: merged }],
  };
  const text = draft([repo({ branch: "main", isDefault: true, ticket: null })], activity);
  const yesterday = text.split("*Today:*")[0];
  assert.match(yesterday, /_Checkout https:\/\/git\.example\.com\/groups\/team\/-\/epics\/3_\n• Home page view https:\/\/git\.example\.com\/team\/shop\/-\/merge_requests\/83/);
  assert.doesNotMatch(text, /Resolve "|_Other_/);
});
