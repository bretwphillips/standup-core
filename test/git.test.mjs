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
  git(shop, "checkout", "-q", "12-checkout-button");
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

test("branch names", () => {
  assert.equal(ticketFrom("31-login-form"), "#31");
  assert.equal(ticketFrom("main"), null);
  assert.equal(titleFrom("31-login-form"), "Login form");
  assert.equal(webBase("https://git.example.com/team/shop.git"), "https://git.example.com/team/shop");
});
