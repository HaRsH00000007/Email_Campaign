// INTEGRATION TEST: a campaign keeps sending past the former daily quota, and
// the worker defers rather than fails when Google throttles.
//
// Sending is MOCKED at the transport seam (services/gmail/sender), so no mail
// leaves the machine and no Google credentials are needed. Everything below
// that seam -- the claim, the idempotence gate, the quota refund, the retry
// decision -- is the real code.
//
// Runs against an in-process MongoDB (mongodb-memory-server). If that package
// is absent the whole file SKIPS, so the unit suite stays runnable without it.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

process.env.TOKEN_ENC_KEY = process.env.TOKEN_ENC_KEY || "k".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "t".repeat(48);
// Keep the limiter out of the way: this file is about the campaign and worker
// decisions. Spacing itself is proven in mailboxSpacing.test.js.
process.env.MAILBOX_MIN_SPACING_MS = "0";
delete process.env.MAILBOX_HOURLY_LIMIT;

// Run this file with Redis DISABLED, so the limiter short-circuits to
// "unenforced" and no connection is opened. It must be set to "" rather than
// deleted: config/env.js calls dotenv, which fills in any key that is ABSENT
// from process.env but leaves a key that is merely empty alone. Deleting it
// therefore hands the key straight back and leaves an ioredis handle open that
// keeps the test process alive forever.
process.env.REDIS_URL = "";

let MongoMemoryServer;
try {
  ({ MongoMemoryServer } = require("mongodb-memory-server"));
} catch {
  MongoMemoryServer = null;
}

const mongoose = require("mongoose");

// -- Mock the transport seam ------------------------------------------------
// Replacing the module in require.cache BEFORE the worker is required means the
// worker closes over the mock. This is the whole reason sendViaAccount exists
// as a seam.
const senderPath = require.resolve("../src/services/gmail/sender");
const realSender = require(senderPath);

const outbox = [];
let nextResult = () => ({ ok: true, id: "m1", threadId: "t1" });

require.cache[senderPath].exports = {
  ...realSender,
  sendViaAccount: async (args) => {
    outbox.push(args);
    return nextResult(outbox.length, args);
  },
};

const suite = MongoMemoryServer ? test : test.skip;

suite("continuous sending (integration)", async (t) => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("email_campaigning_continuous"));

  const { EmailMessage, EmailCampaign, EmailAccount, User } = require("../src/models");
  const { processEmailJob } = require("../src/workers/emailWorker");
  const { DelayedError } = require("bullmq");

  t.after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  const user = await User.create({
    email: "op@example.com",
    passwordHash: "scrypt$1$00$00",
    name: "Op",
  });

  const account = await EmailAccount.create({
    userId: user._id,
    email: "sender@example.com",
    provider: "gmail",
    connected: true,
    grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
  });

  const campaign = await EmailCampaign.create({
    userId: user._id,
    name: "Continuous",
    status: "active",
    emailAccountIds: [account._id],
    pitches: [{ subject: "Hi {{name}}", html: "<p>Hello</p>" }],
    followup: { enabled: false, steps: [] },
  });

  // A minimal stand-in for a BullMQ job. moveToDelayed is what the worker calls
  // to PARK work, so recording it is how we assert "deferred, not failed".
  const makeJob = (messageId, attemptsMade = 0) => {
    const job = {
      data: { messageId: String(messageId) },
      attemptsMade,
      delayedTo: null,
      moveToDelayed: async (ts) => {
        job.delayedTo = ts;
      },
    };
    return job;
  };

  const claim = async (leadEmail) =>
    EmailMessage.create({
      campaignId: campaign._id,
      userId: user._id,
      leadEmail,
      stage: "pitch",
      status: "queued",
      sendingAccountId: account._id,
    });

  const run = async (msg, attemptsMade = 0) => {
    const job = makeJob(msg._id, attemptsMade);
    try {
      return { result: await processEmailJob(job, "tok"), job, delayed: false };
    } catch (e) {
      if (e instanceof DelayedError || e?.name === "DelayedError") {
        return { result: null, job, delayed: true };
      }
      return { result: null, job, delayed: false, threw: e };
    }
  };

  // ---------------------------------------------------------------------
  await t.test("sending continues well past the former 500/day campaign quota", async () => {
    // The old code zeroed the per-tick budget once progress.sentToday reached
    // campaign.dailyLimit (default 500) and the campaign went mute until UTC
    // midnight. Drive the counter far past it and assert sends still happen.
    campaign.progress.sentToday = 5000;
    campaign.progress.totalSent = 5000;
    campaign.dailyLimit = 500; // the deprecated field, deliberately still set
    await campaign.save();

    outbox.length = 0;
    nextResult = () => ({ ok: true, id: "ok", threadId: "th" });

    for (let i = 0; i < 5; i++) {
      const msg = await claim(`past-quota-${i}@example.com`);
      const { result, delayed } = await run(msg);
      assert.strictEqual(delayed, false, `send ${i} must not be parked`);
      assert.strictEqual(result?.sent, true, `send ${i} must go out`);
    }

    assert.strictEqual(outbox.length, 5, "all five reached the transport");
    const sent = await EmailMessage.countDocuments({
      campaignId: campaign._id,
      status: "sent",
      leadEmail: /past-quota/,
    });
    assert.strictEqual(sent, 5);
  });

  // ---------------------------------------------------------------------
  await t.test("a Gmail rate limit DEFERS the job without burning an attempt", async () => {
    const msg = await claim("throttled@example.com");
    outbox.length = 0;
    nextResult = () => ({
      ok: false,
      error: "You have reached a limit for sending mail.",
      status: 429,
      retryable: true,
      rateLimited: true,
      retryAfterMs: 120_000,
    });

    const before = Date.now();
    const { delayed, job } = await run(msg);

    assert.strictEqual(delayed, true, "a throttle must park the job, not fail it");
    assert.ok(job.delayedTo >= before + 120_000, "it must wait at least Google's Retry-After");

    // The row stays queued, so the idempotence gate lets the retry through and
    // the lead is not lost.
    const after = await EmailMessage.findById(msg._id).lean();
    assert.strictEqual(after.status, "queued", "the row must stay claimed and retryable");
    assert.strictEqual(after.error || "", "", "a deferral is not an error");
  });

  // ---------------------------------------------------------------------
  await t.test("a throttle on the LAST attempt still defers rather than dead-lettering", async () => {
    // The important case. Previously this path hit the attempts ceiling and
    // dead-lettered a perfectly deliverable email because Gmail was busy.
    const msg = await claim("throttled-last@example.com");
    nextResult = () => ({
      ok: false,
      error: "rateLimitExceeded",
      status: 429,
      retryable: true,
      rateLimited: true,
      retryAfterMs: 60_000,
    });

    const { delayed } = await run(msg, 99); // way past MAX_ATTEMPTS
    assert.strictEqual(delayed, true);

    const after = await EmailMessage.findById(msg._id).lean();
    assert.strictEqual(after.status, "queued", "must not be marked failed");
  });

  // ---------------------------------------------------------------------
  await t.test("a PERMANENT failure is still failed, not retried forever", async () => {
    // The opposite guard: loosening throttle handling must not make dead
    // addresses immortal.
    const msg = await claim("nosuch@example.invalid");
    nextResult = () => ({
      ok: false,
      error: "Invalid to header",
      status: 400,
      retryable: false,
      rateLimited: false,
    });

    const { result, delayed } = await run(msg);
    assert.strictEqual(delayed, false, "a permanent failure must not be parked");
    assert.strictEqual(result?.failed, true);

    const after = await EmailMessage.findById(msg._id).lean();
    assert.strictEqual(after.status, "failed");
    assert.match(after.error, /Invalid to header/);
  });

  // ---------------------------------------------------------------------
  await t.test("duplicate jobs for one claim send exactly once", async () => {
    // At-least-once queue delivery meets the idempotence gate. Both the
    // redelivered job and a reaper re-queue must converge on one email.
    const msg = await claim("dupe@example.com");
    outbox.length = 0;
    nextResult = () => ({ ok: true, id: "once", threadId: "th" });

    const first = await run(msg);
    const second = await run(msg);
    const third = await run(msg);

    assert.strictEqual(first.result?.sent, true);
    assert.strictEqual(second.result?.skipped, "already_sent");
    assert.strictEqual(third.result?.skipped, "already_sent");
    assert.strictEqual(outbox.length, 1, "the transport was called exactly once");
  });

  // ---------------------------------------------------------------------
  await t.test("CONCURRENT workers racing for one lead send exactly once", async () => {
    // WHERE THE GUARANTEE ACTUALLY LIVES. The worker's `status !== "queued"`
    // gate is a SEQUENTIAL redelivery gate -- a read-then-write that four
    // simultaneous processors of the SAME job would all pass. It does not need
    // to survive that, because BullMQ holds a per-job lock and never hands one
    // job to two workers at once.
    //
    // The race that really happens is two schedulers reaching the same LEAD,
    // and that is settled by the unique partial index: the claiming insert is
    // the atomic act of taking ownership, so the losers get E11000 and skip.
    // That is what this exercises.
    await EmailMessage.syncIndexes();

    outbox.length = 0;
    nextResult = async () => {
      await new Promise((r) => setTimeout(r, 40)); // hold the "network call" open
      return { ok: true, id: "race", threadId: "th" };
    };

    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () => claim("race@example.com"))
    );
    const won = attempts.filter((a) => a.status === "fulfilled");
    const lost = attempts.filter((a) => a.status === "rejected");

    assert.strictEqual(won.length, 1, `exactly one claim may win, got ${won.length}`);
    assert.strictEqual(lost.length, 3);
    for (const l of lost) {
      assert.strictEqual(l.reason.code, 11000, "losers must lose on the unique index");
    }

    // The single surviving claim produces exactly one email.
    const results = await Promise.all(won.map((w) => run(w.value)));
    assert.strictEqual(results.filter((r) => r.result?.sent).length, 1);
    assert.strictEqual(outbox.length, 1, "the transport saw exactly one call");
  });

  // ---------------------------------------------------------------------
  await t.test("a paused campaign parks its in-flight jobs instead of sending", async () => {
    const msg = await claim("paused@example.com");
    outbox.length = 0;
    nextResult = () => ({ ok: true, id: "nope", threadId: "th" });

    campaign.status = "paused";
    await campaign.save();

    const { delayed } = await run(msg);
    assert.strictEqual(delayed, true, "a pause must hold the job");
    assert.strictEqual(outbox.length, 0, "nothing may reach the transport");

    campaign.status = "active";
    await campaign.save();
  });
});
