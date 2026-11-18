import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBody } from "../../src/components/MessageBody";

test("message text safely renders code, web links, lists and unfinished streamed fences", () => {
  const html = renderToStaticMarkup(createElement(MessageBody, {text:
    "**Notes**\n\n- [link](https://example.org)\n- `inline`\n\n1. next\n\n```js\n<script>demo</script>"}));
  for (const tag of ["<strong>Notes</strong>", "<ul>", "<ol>", 'href="https://example.org"', "<code>inline</code>", "<pre><code>&lt;script&gt;demo&lt;/script&gt;"]) assert.ok(html.includes(tag), tag);
  const plain = renderToStaticMarkup(createElement(MessageBody, {text:"[unsafe](javascript:void)"}));
  assert.ok(!plain.includes("href="));
});
