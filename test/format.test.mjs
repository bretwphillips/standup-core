import { test } from "node:test";
import assert from "node:assert/strict";
import { toHTML, toText } from "../format.mjs";

test("links shorten to their tokens, bullets become a list", () => {
  const html = toHTML([
    "*Today:*",
    "_Checkout https://git.example.com/groups/team/-/epics/3_",
    "• Add the button https://git.example.com/team/shop/-/merge_requests/41",
    "• Receipts https://github.com/someone/shop/issues/44",
    "",
    "*Blockers:* none",
  ].join("\n"));
  assert.match(html, /<p><b>Today:<\/b><\/p>/);
  assert.match(html, /<i>Checkout <a href="https:\/\/git\.example\.com\/groups\/team\/-\/epics\/3">&amp;3<\/a><\/i>/);
  assert.match(html, /<ul><li>Add the button <a href="[^"]+merge_requests\/41">!41<\/a><\/li><li>Receipts <a href="[^"]+issues\/44">#44<\/a><\/li><\/ul>/);
  assert.match(html, /<p><br><\/p><p><b>Blockers:<\/b> none<\/p>$/);
});

test("text is escaped", () => {
  assert.equal(toHTML("• a <b> & c"), "<ul><li>a &lt;b&gt; &amp; c</li></ul>");
});

test("the plain text reads as the HTML does: tokens, not addresses", () => {
  const text = toText([
    "*Today:*",
    "_Checkout https://git.example.com/groups/team/-/epics/3_",
    "• Add the button https://git.example.com/team/shop/-/merge_requests/41",
    "• a <b> & c",
    "",
    "*Blockers:* none",
  ].join("\n"));
  assert.equal(text, "Today:\nCheckout &3\n• Add the button !41\n• a <b> & c\n\nBlockers: none");
});
