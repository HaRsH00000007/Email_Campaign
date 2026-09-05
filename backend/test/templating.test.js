// Templating and the plain-text-to-HTML conversion.

const test = require("node:test");
const assert = require("node:assert");

const {
  render,
  unresolvedTokens,
  toEmailHtml,
  toText,
} = require("../src/services/personalization/templating");

test("renders tokens case-insensitively and whitespace-tolerantly", () => {
  const fields = { firstName: "Sarah", Company: "Acme" };
  assert.strictEqual(render("Hi {{firstName}}", fields), "Hi Sarah");
  assert.strictEqual(render("Hi {{FIRSTNAME}}", fields), "Hi Sarah");
  assert.strictEqual(render("Hi {{  firstName  }}", fields), "Hi Sarah");
  assert.strictEqual(render("At {{company}}", fields), "At Acme");
});

test("a dotted header still resolves -- Map keys cannot hold a dot", () => {
  // The importer stores "Phone No." as "Phone No", but a template written
  // against the spreadsheet header must still find it.
  assert.strictEqual(render("Call {{Phone No.}}", { "Phone No": "555" }), "Call 555");
});

test("an unknown token renders EMPTY, never as literal braces", () => {
  // A blank reads as a stylistic choice; "{{ghost}}" in a delivered email reads
  // as broken software.
  assert.strictEqual(render("Hi {{ghost}}!", { firstName: "Sarah" }), "Hi !");
});

test("unresolvedTokens reports what would render empty", () => {
  const bad = unresolvedTokens("Hi {{firstName}} at {{company}}", ["firstName"]);
  assert.deepStrictEqual(bad, ["company"]);
});

test("works with a Mongoose-style Map", () => {
  const map = new Map([["firstName", "Sarah"]]);
  assert.strictEqual(render("Hi {{firstName}}", map), "Hi Sarah");
});

test("plain text keeps its line breaks as <br>", () => {
  const html = toEmailHtml("Line one\nLine two");
  assert.ok(html.includes("Line one<br>Line two"), html);
  assert.ok(html.includes("pre-wrap"), "runs of spaces must survive too");
});

test("plain text is escaped so typed markup cannot become live HTML", () => {
  const html = toEmailHtml("5 < 10 & 20 > 15");
  assert.ok(html.includes("&lt;"), html);
  assert.ok(html.includes("&amp;"), html);
});

test("an inline <a> the user inserted survives escaping", () => {
  const html = toEmailHtml('Book here: <a href="https://x.com">link</a>\nThanks');
  assert.ok(html.includes('<a href="https://x.com">link</a>'), html);
  assert.ok(html.includes("<br>"), "surrounding newlines must still convert");
});

test("authored block HTML is wrapped, not escaped", () => {
  const html = toEmailHtml("<p>Hello</p><p>World</p>");
  assert.ok(html.includes("<p>Hello</p>"), html);
  assert.ok(!html.includes("&lt;p&gt;"), "authored HTML must not be escaped");
});

test("a full HTML document ships verbatim", () => {
  const doc = "<!doctype html><html><body><h1>Hi</h1></body></html>";
  assert.strictEqual(toEmailHtml(doc), doc);
});

test("toText produces a readable plain part", () => {
  // Each closing block tag becomes one newline; the result is trimmed. This is
  // the multipart/alternative fallback for text-only clients, so readability
  // matters more than reproducing exact spacing.
  assert.strictEqual(toText("<p>Hello</p><p>World</p>"), "Hello\nWorld");
  assert.strictEqual(toText("Line one<br>Line two"), "Line one\nLine two");
  assert.strictEqual(toText("<p>Only</p>"), "Only");
});
