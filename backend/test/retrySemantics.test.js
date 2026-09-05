// Retry classification and the status taxonomy.
//
// These two decide whether a transient failure costs you a lead, and whether a
// bounce inflates your reply rate. Both were production bugs in the reference
// implementation before the distinctions existed.

const test = require("node:test");
const assert = require("node:assert");

process.env.TOKEN_ENC_KEY = process.env.TOKEN_ENC_KEY || "0".repeat(64);

const { isRetryable } = require("../src/services/gmail/sender");
const {
  isDelivered,
  isTerminal,
  DELIVERED_STATES,
  PENDING_STATES,
  TYPE_TO_STATUS,
} = require("../src/services/replies/statusSets");

test("a 429 is retryable -- a rate limit must not cost the lead", () => {
  assert.strictEqual(isRetryable({ error: "rate limited", status: 429 }), true);
});

test("5xx is retryable", () => {
  assert.strictEqual(isRetryable({ error: "boom", status: 500 }), true);
  assert.strictEqual(isRetryable({ error: "boom", status: 503 }), true);
});

test("a transport error with no status is retryable", () => {
  assert.strictEqual(isRetryable({ error: "ECONNRESET", status: undefined }), true);
});

test("401/403 is retryable once -- the token refresh may fix it", () => {
  assert.strictEqual(isRetryable({ error: "unauthorized", status: 401 }), true);
  assert.strictEqual(isRetryable({ error: "forbidden", status: 403 }), true);
});

test("400 and 404 are PERMANENT -- retrying a malformed message is pointless", () => {
  assert.strictEqual(isRetryable({ error: "bad request", status: 400 }), false);
  assert.strictEqual(isRetryable({ error: "not found", status: 404 }), false);
});

test("local pre-flight failures are permanent regardless of status", () => {
  assert.strictEqual(isRetryable({ error: "missing_recipient" }), false);
  assert.strictEqual(isRetryable({ error: "scope_not_granted" }), false);
  assert.strictEqual(isRetryable({ error: "account_not_found" }), false);
  assert.strictEqual(isRetryable({ error: "not_connected" }), false);
});

test("an auto-reply counts as DELIVERED -- it proves the mailbox exists", () => {
  assert.strictEqual(isDelivered("auto_reply"), true);
  assert.ok(DELIVERED_STATES.includes("auto_reply"));
});

test("a bounce is NOT delivered -- it must not inflate the denominator", () => {
  assert.strictEqual(isDelivered("bounced"), false);
  assert.strictEqual(isDelivered("soft_bounced"), false);
  assert.strictEqual(isDelivered("failed"), false);
  assert.strictEqual(isDelivered("queued"), false);
});

test("auto_reply is NOT terminal -- a real reply can still arrive after it", () => {
  assert.strictEqual(isTerminal("auto_reply"), false);
  assert.ok(PENDING_STATES.includes("auto_reply"), "so it keeps being polled");
});

test("replies and bounces ARE terminal", () => {
  assert.strictEqual(isTerminal("replied"), true);
  assert.strictEqual(isTerminal("bounced"), true);
  assert.strictEqual(isTerminal("soft_bounced"), true);
});

test("classifier types map onto stored statuses", () => {
  assert.strictEqual(TYPE_TO_STATUS.reply, "replied");
  assert.strictEqual(TYPE_TO_STATUS.bounced, "bounced");
  assert.strictEqual(TYPE_TO_STATUS.soft_bounce, "soft_bounced");
  assert.strictEqual(TYPE_TO_STATUS.auto_reply, "auto_reply");
});
