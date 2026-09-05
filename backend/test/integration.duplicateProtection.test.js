// INTEGRATION TEST: the duplicate-send guarantee.
//
// This is the single most important property in the system, and it is enforced
// by the DATABASE, not by application logic -- so it can only be proven against
// a real MongoDB. Everything else (the queue, the worker, the scheduler) is
// built on the assumption that this holds.
//
// Runs against an in-process MongoDB (mongodb-memory-server), so it needs no
// running service. The first run downloads a mongod binary and is slow;
// afterwards it is cached.
//
// If mongodb-memory-server is not installed, the whole file SKIPS rather than
// failing -- it is a devDependency, and the unit suite must stay runnable
// without it.

const test = require("node:test");
const assert = require("node:assert");

process.env.TOKEN_ENC_KEY = process.env.TOKEN_ENC_KEY || "k".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "t".repeat(48);

let MongoMemoryServer;
try {
  ({ MongoMemoryServer } = require("mongodb-memory-server"));
} catch {
  MongoMemoryServer = null;
}

const mongoose = require("mongoose");

const suite = MongoMemoryServer ? test : test.skip;

suite("duplicate-send protection (integration)", async (t) => {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("email_campaigning_test"));

  const { EmailMessage, EmailCampaign, EmailLead, EmailLeadList, User } = require("../src/models");
  const { verifyCriticalIndexes } = require("../scripts/lib/indexes");
  const { getLeadCount } = require("../src/services/campaigns/leadCount");

  t.after(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  // ---------------------------------------------------------------------
  await t.test("the unique indexes actually BUILD on a fresh database", async () => {
    const report = await verifyCriticalIndexes();
    assert.strictEqual(report.ok, true, `missing: ${report.missing?.join(", ")}`);
  });

  // ---------------------------------------------------------------------
  const user = await User.create({
    email: "op@example.com",
    passwordHash: "scrypt$1$00$00",
    name: "Op",
  });
  const campaign = await EmailCampaign.create({
    userId: user._id,
    name: "Test campaign",
    pitches: [{ subject: "Hi", html: "Hello" }],
  });

  const claimPitch = () =>
    EmailMessage.create({
      campaignId: campaign._id,
      userId: user._id,
      leadEmail: "lead@example.com",
      stage: "pitch",
      status: "queued",
    });

  await t.test("a second pitch claim for the same lead is REJECTED by the database", async () => {
    await claimPitch();
    await assert.rejects(claimPitch(), (e) => e.code === 11000);

    const n = await EmailMessage.countDocuments({
      campaignId: campaign._id,
      leadEmail: "lead@example.com",
      stage: "pitch",
    });
    assert.strictEqual(n, 1, "exactly one pitch row may exist");
  });

  // ---------------------------------------------------------------------
  await t.test("20 workers racing on ONE lead produce exactly ONE claim", async () => {
    // This is the real scenario: concurrent workers, no coordination between
    // them, all reaching for the same lead at the same instant. An
    // "if (!alreadySent) send()" check would let several through here.
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        EmailMessage.create({
          campaignId: campaign._id,
          userId: user._id,
          leadEmail: "raced@example.com",
          stage: "pitch",
          status: "queued",
        })
      )
    );

    const won = results.filter((r) => r.status === "fulfilled").length;
    const lost = results.filter(
      (r) => r.status === "rejected" && r.reason?.code === 11000
    ).length;

    assert.strictEqual(won, 1, "exactly one worker may win the claim");
    assert.strictEqual(lost, 19, "every other worker must lose with E11000");
  });

  // ---------------------------------------------------------------------
  await t.test("a lead may be claimed independently by a DIFFERENT campaign", async () => {
    // The constraint is per (campaign, lead) -- a shared list must remain
    // mailable by a second campaign.
    const other = await EmailCampaign.create({
      userId: user._id,
      name: "Second campaign",
      pitches: [{ subject: "Hi", html: "Hello" }],
    });

    await assert.doesNotReject(
      EmailMessage.create({
        campaignId: other._id,
        userId: user._id,
        leadEmail: "lead@example.com",
        stage: "pitch",
        status: "queued",
      })
    );
  });

  // ---------------------------------------------------------------------
  await t.test("follow-up STEPS are independently unique per lead", async () => {
    const mk = (step) =>
      EmailMessage.create({
        campaignId: campaign._id,
        userId: user._id,
        leadEmail: "lead@example.com",
        stage: "followup",
        followupStep: step,
        status: "queued",
      });

    await mk(0);
    await mk(1); // a DIFFERENT step is allowed
    await assert.rejects(mk(0), (e) => e.code === 11000, "step 0 cannot repeat");

    const n = await EmailMessage.countDocuments({
      campaignId: campaign._id,
      leadEmail: "lead@example.com",
      stage: "followup",
    });
    assert.strictEqual(n, 2);
  });

  // ---------------------------------------------------------------------
  await t.test("racing on ONE follow-up step also yields exactly one row", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        EmailMessage.create({
          campaignId: campaign._id,
          userId: user._id,
          leadEmail: "racedfu@example.com",
          stage: "followup",
          followupStep: 3,
          status: "queued",
        })
      )
    );
    assert.strictEqual(results.filter((r) => r.status === "fulfilled").length, 1);
  });

  // ---------------------------------------------------------------------
  await t.test("leadCount NEVER reports an unverified zero", async () => {
    // The contract that stopped a large campaign stalling at a few emails an
    // hour: a 0 or missing stored count must be verified against the lead
    // documents before it is reported.
    const list = await EmailLeadList.create({
      userId: user._id,
      name: "Healing list",
      columns: ["email"],
      leadCount: 0, // WRONG on purpose
      importStatus: { state: "done", inserted: 3, total: 3, updatedAt: new Date() },
    });

    await EmailLead.insertMany([
      { listId: list._id, idx: 0, email: "a@x.com" },
      { listId: list._id, idx: 1, email: "b@x.com" },
      { listId: list._id, idx: 2, email: "c@x.com" },
    ]);

    const n = await getLeadCount(list._id);
    assert.strictEqual(n, 3, "must count the documents rather than trust the 0");

    const healed = await EmailLeadList.findById(list._id).lean();
    assert.strictEqual(healed.leadCount, 3, "and heal the stored value");
  });

  await t.test("a still-importing list reads as 0, so it cannot be half-mailed", async () => {
    const list = await EmailLeadList.create({
      userId: user._id,
      name: "Importing list",
      columns: ["email"],
      leadCount: 0,
      importStatus: { state: "importing", inserted: 1, total: 500, updatedAt: new Date() },
    });
    await EmailLead.create({ listId: list._id, idx: 0, email: "partial@x.com" });

    // Counting the arriving documents here would return a PARTIAL total and
    // heal it onto the row -- which is exactly what makes a list selectable.
    assert.strictEqual(await getLeadCount(list._id), 0);
  });

  // ---------------------------------------------------------------------
  await t.test("lead idx is unique per list, so a retried import cannot duplicate", async () => {
    const list = await EmailLeadList.create({
      userId: user._id,
      name: "Idx list",
      columns: ["email"],
    });
    await EmailLead.create({ listId: list._id, idx: 0, email: "one@x.com" });
    await assert.rejects(
      EmailLead.create({ listId: list._id, idx: 0, email: "two@x.com" }),
      (e) => e.code === 11000
    );
  });

  // ---------------------------------------------------------------------
  await t.test("campaign stats roll up by delivery meaning, not raw counts", async () => {
    const { recomputeCampaignStats } = require("../src/services/campaigns/stats");
    const c = await EmailCampaign.create({
      userId: user._id,
      name: "Stats campaign",
      pitches: [{ subject: "s", html: "h" }],
    });

    const rows = [
      ["a@x.com", "sent"],
      ["b@x.com", "replied"],
      ["c@x.com", "auto_reply"],
      ["d@x.com", "bounced"],
      ["e@x.com", "soft_bounced"],
      ["f@x.com", "failed"],
      ["g@x.com", "queued"],
    ];
    for (const [leadEmail, status] of rows) {
      await EmailMessage.create({
        campaignId: c._id,
        userId: user._id,
        leadEmail,
        stage: "pitch",
        status,
      });
    }

    const stats = await recomputeCampaignStats(c._id);
    assert.strictEqual(stats.total, 7);
    // Delivered = sent + replied + auto_reply. An auto-reply proves the mailbox
    // exists; a bounce proves it does not.
    assert.strictEqual(stats.sent, 3, "delivered must exclude bounces and failures");
    assert.strictEqual(stats.replied, 1);
    assert.strictEqual(stats.bounced, 1, "hard bounce only");
    assert.strictEqual(stats.other, 2, "soft bounce + auto-reply");
    assert.strictEqual(stats.failed, 1);
    assert.strictEqual(stats.queued, 1);
  });
});
