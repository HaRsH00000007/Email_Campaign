// How we classify what Google tells us, and what the worker does about it.
//
// These are pure-function tests over the transport seam. The mistake they exist
// to catch is the permissive one: treating a throttle as an ordinary failure
// and retrying straight back into it, which is how a mailbox goes from
// temporarily limited to suspended.

const test = require("node:test");
const assert = require("node:assert");

process.env.TOKEN_ENC_KEY = process.env.TOKEN_ENC_KEY || "k".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "t".repeat(48);

const {
  isRetryable,
  isRateLimit,
  parseRetryAfter,
  MAX_COOLDOWN_MS,
} = require("../src/services/gmail/sender");

test("a 429 is a rate limit", () => {
  assert.strictEqual(isRateLimit({ status: 429 }), true);
  assert.strictEqual(isRetryable({ status: 429 }), true);
});

test("Gmail's send-limit trip is caught even though it arrives as a 4xx", () => {
  // The real-world shape: Gmail refuses with 400/403 and a reason string, NOT
  // a 429. Classifying on status alone treats this as permanent and burns the
  // lead -- which is exactly what happened to this project's first campaign.
  assert.strictEqual(
    isRateLimit({
      status: 400,
      message: "You have reached a limit for sending mail. Your message was not sent.",
    }),
    true
  );
  assert.strictEqual(isRateLimit({ status: 403, reason: "userRateLimitExceeded" }), true);
  assert.strictEqual(isRateLimit({ status: 403, reason: "dailyLimitExceeded" }), true);
  assert.strictEqual(isRateLimit({ status: 429, reason: "rateLimitExceeded" }), true);
});

test("a genuinely permanent failure is NOT treated as a rate limit", () => {
  // The other direction matters just as much: a dead address must not park the
  // whole mailbox for 15 minutes.
  assert.strictEqual(
    isRateLimit({ status: 400, message: "Invalid to header", reason: "invalidArgument" }),
    false
  );
  assert.strictEqual(isRateLimit({ status: 404, message: "Not Found" }), false);
  assert.strictEqual(isRetryable({ status: 400 }), false);
  assert.strictEqual(isRetryable({ error: "missing_recipient", status: null }), false);
});

test("transport and server errors stay retryable", () => {
  assert.strictEqual(isRetryable({ status: null }), true); // network
  assert.strictEqual(isRetryable({ status: 503 }), true);
  assert.strictEqual(isRetryable({ status: 401 }), true); // token may refresh
});

test("Retry-After in seconds is honoured", () => {
  assert.strictEqual(parseRetryAfter("120"), 120_000);
  assert.strictEqual(parseRetryAfter("0"), 0);
});

test("Retry-After as an HTTP date is honoured", () => {
  const when = new Date(Date.now() + 90_000).toUTCString();
  const ms = parseRetryAfter(when);
  assert.ok(ms > 80_000 && ms <= 92_000, `expected ~90s, got ${ms}`);
});

test("a Retry-After in the past yields 0, never a negative delay", () => {
  // A negative delay passed to moveToDelayed would schedule the job in the
  // past, i.e. immediately -- silently defeating the deferral.
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.strictEqual(parseRetryAfter(past), 0);
});

test("an absurd Retry-After is capped rather than parking a job for days", () => {
  assert.strictEqual(parseRetryAfter("9999999"), MAX_COOLDOWN_MS);
});

test("a missing or junk Retry-After falls back to our own guess", () => {
  assert.strictEqual(parseRetryAfter(""), null);
  assert.strictEqual(parseRetryAfter(null), null);
  assert.strictEqual(parseRetryAfter("soon"), null);
});

test("the re-park delay never undercuts the wait the limiter asked for", () => {
  // Jitter spreads a queued herd, but it is ADDED, never subtracted -- if it
  // could subtract, the 60s spacing guarantee would leak.
  const { reparkDelay } = require("../src/workers/emailWorker");
  for (let i = 0; i < 200; i++) {
    const d = reparkDelay(60_000);
    assert.ok(d >= 60_000, `delay ${d} must be >= the requested 60000`);
    assert.ok(d <= 65_000, `delay ${d} must stay close to the request`);
  }
});

test("the re-park delay is capped and handles junk input", () => {
  const { reparkDelay } = require("../src/workers/emailWorker");
  assert.ok(reparkDelay(999 * 3600_000) <= 6 * 3600_000 + 5_000);
  assert.ok(reparkDelay(undefined) >= 60_000);
  assert.ok(reparkDelay(-5) >= 1);
});
