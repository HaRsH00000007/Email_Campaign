// The AI rewrite validators. These are the guardrails that decide whether a
// model's output is allowed to reach a real person, so each case here is a
// specific way a rewrite can be worse than the original.
//
// Runs offline -- adversarial outputs are fed to the validator directly, so no
// API key and no network are needed.

const test = require("node:test");
const assert = require("node:assert");

process.env.TOKEN_ENC_KEY = process.env.TOKEN_ENC_KEY || "0".repeat(64);

const {
  validateRewrite,
  urlsPreserved,
  emailsPreserved,
  numbersPreserved,
  containsWord,
  fieldValuesPreserved,
  formatMatches,
  hasUnrenderedToken,
  lengthSane,
} = require("../src/services/personalization/uniquifier");

const base = {
  subject: "Quick question about Acme's hiring",
  body: "Hi Sarah,\n\nWe help teams at Acme cut time-to-hire by 30%. Worth a 15 min call?\n\nhttps://example.com/book\n\nBest,\nDana",
};
const fields = { firstName: "Sarah", company: "Acme" };

const ok = (next) => validateRewrite({ original: base, next, fields });

test("a faithful rewrite passes", () => {
  const r = ok({
    subject: "A quick note on hiring at Acme",
    body: "Hi Sarah,\n\nTeams at Acme use us to reduce time-to-hire by 30%. Open to a 15 min chat?\n\nhttps://example.com/book\n\nBest,\nDana",
  });
  assert.strictEqual(r.ok, true, r.reason);
});

test("a dropped URL is rejected", () => {
  const r = ok({
    subject: "A quick note on hiring at Acme",
    body: "Hi Sarah,\n\nTeams at Acme cut time-to-hire by 30%. Open to a 15 min chat?\n\nBest,\nDana",
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "url_altered_or_dropped");
});

test("an ALTERED URL is rejected -- a rewritten link is worse than a duplicate email", () => {
  const r = ok({
    subject: "A quick note on hiring at Acme",
    body: "Hi Sarah,\n\nTeams at Acme cut time-to-hire by 30%. Chat?\n\nhttps://example.com/booking\n\nBest,\nDana",
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "url_altered_or_dropped");
});

test("an invented number is rejected", () => {
  const r = ok({
    subject: "A quick note on hiring at Acme",
    body: "Hi Sarah,\n\nTeams at Acme cut time-to-hire by 45%. Worth a 15 min call?\n\nhttps://example.com/book\n\nBest,\nDana",
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "number_invented");
});

test("dropping a number is allowed -- rewording '15 min' as 'a quick call' is fine", () => {
  const r = ok({
    subject: "A quick note on hiring at Acme",
    body: "Hi Sarah,\n\nTeams at Acme cut time-to-hire by 30%. Worth a quick call?\n\nhttps://example.com/book\n\nBest,\nDana",
  });
  assert.strictEqual(r.ok, true, r.reason);
});

test("a surviving {{token}} is rejected", () => {
  const r = ok({
    subject: "A quick note on hiring at Acme",
    body: "Hi {{firstName}},\n\nTeams at Acme cut time-to-hire by 30%. Call?\n\nhttps://example.com/book\n\nBest,\nDana",
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "unrendered_template_token");
});

test("flattening the recipient's name to 'Hi there' is rejected", () => {
  const r = ok({
    subject: "A quick note on hiring at Acme",
    body: "Hi there,\n\nTeams at Acme cut time-to-hire by 30%. Call?\n\nhttps://example.com/book\n\nBest,\nDana",
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.startsWith("lead_field_dropped"), r.reason);
});

test("markdown output is rejected -- clients render it as literal asterisks", () => {
  const r = ok({
    subject: "A quick note on hiring at Acme",
    body: "Hi Sarah,\n\n**Teams at Acme** cut time-to-hire by 30%. Call?\n\nhttps://example.com/book\n\nBest,\nDana",
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "format_changed");
});

test("truncating to a sentence is rejected", () => {
  const r = ok({ subject: "Hi", body: "Hi Sarah. https://example.com/book" });
  assert.strictEqual(r.ok, false);
});

test("an empty rewrite is rejected", () => {
  const r = ok({ subject: "", body: "" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "empty_rewrite");
});

test("containsWord anchors on word boundaries", () => {
  // The bug this guards: plain .includes() reports a DROPPED name as preserved,
  // because "Tom" is a substring of "automated" and "Ann" of "planned".
  assert.strictEqual(containsWord("this is automated", "Tom"), false);
  assert.strictEqual(containsWord("we planned it", "Ann"), false);
  assert.strictEqual(containsWord("trajectory", "Raj"), false);
  assert.strictEqual(containsWord("Hi Tom, how are you", "Tom"), true);
  assert.strictEqual(containsWord("Tom", "Tom"), true);
});

test("short field values are ignored -- a 1-2 char field matches noise", () => {
  const r = fieldValuesPreserved("Hello A there", "Completely different", { initial: "A" });
  assert.strictEqual(r.ok, true);
});

test("an altered email address is rejected", () => {
  assert.strictEqual(
    emailsPreserved("write to dana@example.com", "write to dana@example.net"),
    false
  );
  assert.strictEqual(
    emailsPreserved("write to dana@example.com", "reach dana@example.com anytime"),
    true
  );
});

test("helpers behave on empty input", () => {
  assert.strictEqual(urlsPreserved("no links here", "still none"), true);
  assert.strictEqual(numbersPreserved("no digits", "none either"), true);
  assert.strictEqual(lengthSane("", "anything"), true);
  assert.strictEqual(hasUnrenderedToken(""), false);
  assert.strictEqual(formatMatches("plain", "plain too"), true);
});
