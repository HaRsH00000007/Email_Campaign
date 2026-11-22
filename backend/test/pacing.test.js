// Spread-mode pacing arithmetic and MIME safety.

const test = require("node:test");
const assert = require("node:assert");

const { normalizePacing, computeSchedule } = require("../src/services/campaigns/pacing");
const { buildRaw, encodeHeaderValue, oneLine } = require("../src/services/gmail/mime");

test("pacing values are clamped into a valid range", () => {
  const p = normalizePacing({ durationDays: 999, intervalHours: 0, minDelaySec: -5 });
  assert.strictEqual(p.durationDays, 60);
  assert.strictEqual(p.intervalHours, 1);
  assert.ok(p.minDelaySec >= 1);
});

test("an inverted delay range is corrected, not left invalid", () => {
  const p = normalizePacing({ minDelaySec: 120, maxDelaySec: 30 });
  assert.ok(p.maxDelaySec >= p.minDelaySec);
});

test("a list divides evenly across the duration", () => {
  // 1000 leads over 2 days, one batch an hour = 48 batches.
  const s = computeSchedule(1000, { durationDays: 2, intervalHours: 1 }, 1);
  assert.strictEqual(s.batchesPerDay, 24);
  assert.strictEqual(s.totalBatches, 48);
  assert.strictEqual(s.leadsPerBatch, Math.ceil(1000 / 48));
  // Every lead must be reachable within the duration.
  assert.ok(s.leadsPerBatch * s.totalBatches >= 1000);
});

test("volume splits across mailboxes", () => {
  const one = computeSchedule(1000, { durationDays: 1, intervalHours: 1 }, 1);
  const four = computeSchedule(1000, { durationDays: 1, intervalHours: 1 }, 4);
  assert.strictEqual(four.perDayPerMailbox, one.perDayPerMailbox / 4);
});

test("an empty list produces a schedule rather than dividing by zero", () => {
  const s = computeSchedule(0, { durationDays: 1, intervalHours: 1 }, 1);
  assert.strictEqual(s.leadsPerBatch, 0);
  assert.strictEqual(s.totalLeads, 0);
});

test("a batch that cannot drain within its interval is flagged", () => {
  // 10k leads in one day, 1 batch/hour, 120s average gap: each batch of ~417
  // needs ~14h to drain but only has 1h before the next.
  const s = computeSchedule(10000, {
    durationDays: 1,
    intervalHours: 1,
    minDelaySec: 120,
    maxDelaySec: 120,
  });
  assert.strictEqual(s.batchOverruns, true);
});

test("MIME headers cannot be injected via a subject", () => {
  // A newline in a subject would otherwise let a caller append arbitrary
  // headers (a Bcc to a third party) or terminate the header block early and
  // inject a body. Collapsing CR/LF keeps the payload INSIDE the Subject value,
  // so no new header line is ever created -- which is the property to assert.
  // The literal text "Bcc:" surviving inside the subject is harmless.
  const raw = buildRaw({
    from: "me@example.com",
    to: "you@example.com",
    subject: "Hello\r\nBcc: victim@example.com",
    html: "<p>hi</p>",
  });

  const headerBlock = raw.split("\r\n\r\n")[0];
  const injected = headerBlock.split("\r\n").filter((l) => /^bcc:/i.test(l));
  assert.strictEqual(injected.length, 0, "no Bcc header line may be created");
  assert.ok(
    headerBlock.includes("Subject: Hello Bcc: victim@example.com"),
    "the payload stays inside the Subject value"
  );
  assert.strictEqual(oneLine("a\r\nb"), "a b");
});

test("a non-ASCII subject is RFC 2047 encoded", () => {
  const encoded = encodeHeaderValue("Café ☕ meeting");
  assert.ok(encoded.startsWith("=?UTF-8?B?"), encoded);
  assert.ok(!/[^\x00-\x7F]/.test(encoded), "the encoded header must be pure ASCII");
});

test("an emoji is never split across encoded-word chunks", () => {
  // Chunking by BYTE would slice a surrogate pair and corrupt the character.
  const encoded = encodeHeaderValue("🎉".repeat(40));
  for (const part of encoded.split("\r\n ")) {
    const inner = part.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "");
    const decoded = Buffer.from(inner, "base64").toString("utf8");
    assert.ok(!decoded.includes("�"), "no replacement characters");
  }
});

test("HTML with no text part is sent as a single text/html part", () => {
  const raw = buildRaw({ to: "a@b.com", subject: "x", html: "<p>hi</p>" });
  assert.ok(raw.includes('Content-Type: text/html; charset="UTF-8"'));
  assert.ok(!raw.includes("multipart/alternative"), "nothing for a client to mis-pick");
});

test("html plus text produces multipart/alternative", () => {
  const raw = buildRaw({ to: "a@b.com", subject: "x", html: "<p>hi</p>", text: "hi" });
  assert.ok(raw.includes("multipart/alternative"));
});

// ── 60s cadence defaults and truthful projections ────────────────────────────

test("the DEFAULTS deliver one email per minute, continuously", () => {
  const p = normalizePacing({});
  assert.strictEqual(p.minDelaySec, 60);
  assert.strictEqual(p.maxDelaySec, 60);
  // One batch holding the whole list, so nothing waits on a release interval.
  assert.strictEqual(p.durationDays, 1);
  assert.strictEqual(p.intervalHours, 24);

  const s = computeSchedule(45, p, 1);
  assert.strictEqual(s.leadsPerBatch, 45, "the whole list stages at once");
  assert.strictEqual(s.effectivePerHour, 60, "60s gap == 60/hour");
  assert.strictEqual(s.limitedBy, "gap");
});

test("the projection reports the REAL rate, not the gap's theoretical rate", () => {
  // 45 leads over 5 days, one batch an hour -> leadsPerBatch rounds up to 1, so
  // the mailbox sends once an hour and idles the other 59 minutes. The old card
  // reported "24/day" for this; the honest answer is 1/hour.
  const s = computeSchedule(45, {
    durationDays: 5,
    intervalHours: 1,
    minDelaySec: 60,
    maxDelaySec: 60,
  });
  assert.strictEqual(s.leadsPerBatch, 1);
  assert.strictEqual(s.effectivePerHour, 1, "one per batch, one batch an hour");
  assert.strictEqual(s.limitedBy, "batch_interval");
  assert.strictEqual(s.batchStarves, true, "the operator should be told this idles the mailbox");
});

test("a batch interval cannot silently starve the intended cadence", () => {
  // Same 45 leads, default pacing: finishes in 44 minutes rather than 44 hours.
  const starved = computeSchedule(45, { durationDays: 5, intervalHours: 1 });
  const continuous = computeSchedule(45, { durationDays: 1, intervalHours: 24 });

  assert.ok(continuous.effectivePerHour > starved.effectivePerHour * 50);
  assert.strictEqual(continuous.batchStarves, false);
  assert.strictEqual(Math.round(continuous.estimatedRunMs / 60000), 44);
  assert.strictEqual(Math.round(starved.estimatedRunMs / 3600000), 44);
});

test("the mailbox spacing floor overrides a shorter campaign gap", () => {
  // Asking for a 5s gap does not produce 720/hour: the limiter will hold each
  // send to 60s, so the projection must say 60 and name the reason.
  const s = computeSchedule(100, {
    durationDays: 1,
    intervalHours: 24,
    minDelaySec: 5,
    maxDelaySec: 5,
  }, 1, { mailboxSpacingMs: 60_000 });

  assert.strictEqual(s.effectivePerHour, 60);
  assert.strictEqual(s.limitedBy, "mailbox_spacing");
  // And the run estimate follows the floor, not the wishful gap.
  assert.strictEqual(Math.round(s.estimatedRunMs / 60000), 99);
});

test("more mailboxes raise total throughput without lowering the per-mailbox floor", () => {
  const one = computeSchedule(600, { durationDays: 1, intervalHours: 24 }, 1, {
    mailboxSpacingMs: 60_000,
  });
  const four = computeSchedule(600, { durationDays: 1, intervalHours: 24 }, 4, {
    mailboxSpacingMs: 60_000,
  });

  assert.strictEqual(one.effectivePerHour, 60);
  assert.strictEqual(four.effectivePerHour, 60, "the campaign gap still binds at 60/hour");
  assert.strictEqual(four.effectivePerHourPerMailbox, 15, "each mailbox does a quarter of it");
  // Four mailboxes have 240/hour of headroom, so a shorter gap WOULD now pay off.
  const fast = computeSchedule(600, {
    durationDays: 1,
    intervalHours: 24,
    minDelaySec: 15,
    maxDelaySec: 15,
  }, 4, { mailboxSpacingMs: 60_000 });
  assert.strictEqual(fast.effectivePerHour, 240);
});

test("an empty list still produces finite projections", () => {
  const s = computeSchedule(0, {}, 1, { mailboxSpacingMs: 60_000 });
  assert.strictEqual(s.estimatedRunMs, 0);
  assert.strictEqual(s.batchStarves, false);
  assert.ok(Number.isFinite(s.effectivePerHour) || s.effectivePerHour === 0);
});
