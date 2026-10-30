import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo, findRepos, ticketFrom, titleFrom, webBase } from "../git.mjs";

const ME = "me@example.com";
let root;
const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Me", GIT_AUTHOR_EMAIL: ME, GIT_COMMITTER_NAME: "Me", GIT_COMMITTER_EMAIL: ME },
  });
const commit = (dir, file, message) => {
  writeFileSync(join(dir, file), message);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", message);
};

before(() => {
  root = mkdtempSync(join(tmpdir(), "standup-core-"));
  const shop = join(root, "shop");
  git(root, "init", "-q", "-b", "main", shop);
  git(shop, "remote", "add", "origin", "git@git.example.com:team/shop.git");
  commit(shop, "a.txt", "Start");
  // A branch with work of its own this week.
  git(shop, "checkout", "-q", "-b", "12-checkout-button");
  commit(shop, "b.txt", "Draw the button");
  // A branch whose only commit this week is master merged in.
  git(shop, "checkout", "-q", "main");
  git(shop, "checkout", "-q", "-b", "5-old-work");
  git(shop, "checkout", "-q", "main");
  commit(shop, "c.txt", "Something on main");
  git(shop, "checkout", "-q", "5-old-work");
  git(shop, "merge", "-q", "--no-ff", "--no-edit", "main");
  // Onto main: a direct commit, a version bump, and two merges -- one of a
  // branch with no ticket, one of a ticket's branch.
  git(shop, "checkout", "-q", "main");
  commit(shop, "d.txt", "Fix the footer link");
  commit(shop, "VERSION", "Shop 1.2.0");
  git(shop, "checkout", "-q", "-b", "tidy-readme");
  commit(shop, "e.txt", "Tidy");
  git(shop, "checkout", "-q", "main");
  git(shop, "merge", "-q", "--no-ff", "-m", "Merge pull request #7 from someone/tidy-readme", "-m", "Tidy the README", "tidy-readme");
  git(shop, "merge", "-q", "--no-ff", "-m", "Merge pull request #8 from someone/12-checkout-button", "-m", "Add the checkout button", "12-checkout-button");
  // ...and the ticket's branch carries on past its first merge.
  git(shop, "checkout", "-q", "12-checkout-button");
  commit(shop, "f.txt", "Disable the button while paying");
});
after(() => rmSync(root, { recursive: true, force: true }));

test("finds the repos in a folder, or the folder itself", () => {
  assert.deepEqual(findRepos(root).map((r) => r.name), ["shop"]);
  assert.deepEqual(findRepos(join(root, "shop")).map((r) => r.name), ["shop"]);
});

test("counts your commits on a ticket branch, but not master merged into an idle one", async () => {
  const repo = await scanRepo({ name: "shop", path: join(root, "shop") }, ME);
  assert.equal(repo.branch, "12-checkout-button");
  assert.equal(repo.ticket, "#12");
  assert.equal(repo.web, "https://git.example.com/team/shop");
  assert.equal(repo.branchAuthor, null);
  assert.ok(repo.ticketCommits["#12"]?.length);
  assert.equal(repo.ticketCommits["#5"], undefined);
});

test("work on main with no ticket: direct commits and unnumbered merges, not bumps or a ticket's merge", async () => {
  const repo = await scanRepo({ name: "shop", path: join(root, "shop") }, ME);
  const titles = repo.untracked.map((w) => `${w.title}${w.ref ? ` ${w.ref}` : ""}`);
  assert.ok(titles.includes("Fix the footer link"));
  assert.ok(titles.includes("Tidy the README !7"));
  assert.ok(!titles.some((t) => /1\.2\.0|checkout button/.test(t)));
});

test("branch names", () => {
  assert.equal(ticketFrom("31-login-form"), "#31");
  assert.equal(ticketFrom("main"), null);
  assert.equal(titleFrom("31-login-form"), "Login form");
  assert.equal(webBase("https://git.example.com/team/shop.git"), "https://git.example.com/team/shop");
});
