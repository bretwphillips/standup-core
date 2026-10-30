// The standup as HTML, for the clipboard's rich half: Slack takes that flavour of
// a paste, so links arrive as clickable !41 and #44 instead of a wall of URLs,
// bullets as a real list, and *bold* and _italic_ as themselves.

const escapeHTML = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function toHTML(plain) {
  const out = [];
  let list = false;
  const closeList = () => {
    if (list) out.push("</ul>");
    list = false;
  };

  for (const line of plain.split("\n")) {
    // A URL shortens to its token. The text carries the full address so it can
    // be read and corrected; the paste carries the link.
    let html = escapeHTML(line).replace(/https?:\/\/[^\s<]+/g, (url) => {
      // Trailing punctuation is the sentence's, not the address's -- without
      // this a '_italic_' marker is eaten by the URL and never closes.
      const trail = /[_*.,;:!?)]+$/.exec(url)?.[0] ?? "";
      url = url.slice(0, url.length - trail.length);
      const mr = /\/(?:-\/merge_requests|pull)\/(\d+)/.exec(url);
      const issue = /\/(?:-\/work_items|-\/issues|issues)\/(\d+)/.exec(url);
      const epic = /\/-\/epics\/(\d+)/.exec(url);
      const label = mr ? `!${mr[1]}` : issue ? `#${issue[1]}` : epic ? `&amp;${epic[1]}` : url;
      return `<a href="${url}">${label}</a>${trail}`;
    });

    // Slack's own markers, so they still mean something if a paste ever falls
    // back to plain text. Anchored to whitespace so the underscore in
    // '/-/work_items/27' cannot pair with one in the next URL along.
    html = html
      .replace(/(^|\s)\*([^*\n]+)\*(?=$|\s|[.,;:!?])/g, "$1<b>$2</b>")
      .replace(/(^|\s)_([^_\n]+)_(?=$|\s|[.,;:!?])/g, "$1<i>$2</i>");

    if (line.startsWith("• ")) {
      if (!list) out.push("<ul>");
      list = true;
      out.push(`<li>${html.slice(2)}</li>`);
      continue;
    }
    closeList();
    out.push(line.trim() ? `<p>${html}</p>` : "<p><br></p>");
  }
  closeList();
  return out.join("");
}
