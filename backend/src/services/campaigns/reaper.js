// Recovers message rows that were CLAIMED but never delivered.
//
// THE LEAK THIS CLOSES
//
// The runner claims a lead by inserting a row with status "queued" BEFORE
// handing it to the queue. That claim is what makes duplicate sends impossible
// -- a unique partial index means no one can ever claim that lead again.
//
// Which is exactly the problem when the row gets orphaned. If the process dies
// between the claim and the enqueue, or the queue drops the job, the row sits
// at "queued" forever:
//
//   - the lead is never emailed,
//   - the unique index permanently blocks any future attempt to claim them,
//   - and any reserved quota is never returned.
//
// Nothing else sweeps these up. This does.
//
// WHY RE-ENQUEUEING IS SAFE: enqueueEmail() uses the messageId as the BullMQ
// jobId, so if the job is in fact still alive (for example parked for hours by
// the per-mailbox rate limiter) the add() is a no-op rather than a duplicate.
// And the worker's idempotence gate re-reads the row and skips anything not
// still "queued". The worst case here is a redundant enqueue, never a double
// send.

const { EmailMessage } = require("../../models");
const { enqueueEmail, deadLetter } = require("../queue/emailQueue");
const sendQuota = require("../quota/sendQuota");
const { isEnabled: redisEnabled } = require("../queue/client");
const { num } = require("../../config/env");

// A row queued longer than this is presumed orphaned and gets re-enqueued.
// Comfortably longer than a normal send (including a slow AI rewrite), so we do
// not fight a job that is merely in flight.
const STUCK_AFTER_MS = num("EMAIL_STUCK_AFTER_MS", 15 * 60_000);

// After this long we stop trying: the row is failed, quota is returned, and it
// is dead-lettered so the drop is visible. Generous, because the rate limiter
// can legitimately park a job until the mailbox's daily quota resets.
const GIVE_UP_AFTER_MS = num("EMAIL_GIVE_UP_AFTER_MS", 48 * 3600_000);

const SWEEP_INTERVAL_MS = num("EMAIL_REAPER_INTERVAL_MS", 5 * 60_000);
const BATCH = 200;

let timer = null;
let running = false;

const sweep = async () => {
  if (running) return { skipped: true };
  running = true;

  try {
    const now = Date.now();
    const stuckBefore = new Date(now - STUCK_AFTER_MS);

    const stuck = await EmailMessage.find({
      status: "queued",
      createdAt: { $lt: stuckBefore },
    })
      .select("_id userId campaignId leadEmail stage createdAt")
      .sort({ createdAt: 1 })
      .limit(BATCH)
      .lean();

    if (!stuck.length) return { requeued: 0, abandoned: 0 };

    let requeued = 0;
    let abandoned = 0;

    for (const row of stuck) {
      const age = now - new Date(row.createdAt).getTime();

      if (age > GIVE_UP_AFTER_MS) {
        // Give up. Release the lead's claim as a REAL failure so the row stops
        // being a phantom, return the quota, and make the drop visible.
        await EmailMessage.updateOne(
          // Guard on status so a late success is never clobbered.
          { _id: row._id, status: "queued" },
          { status: "failed", error: "abandoned_stuck_in_queue" }
        ).catch(() => {});
        await sendQuota
          .refund(row.userId, { campaignId: row.campaignId })
          .catch(() => {});
        await deadLetter(row._id, "abandoned_stuck_in_queue", {
          campaignId: String(row.campaignId),
          leadEmail: row.leadEmail,
          stage: row.stage,
          ageMs: age,
        }).catch(() => {});
        abandoned += 1;
        continue;
      }

      await enqueueEmail(row._id).catch(() => {});
      requeued += 1;
    }

    if (requeued || abandoned) {
      console.warn(
        `[reaper] recovered ${requeued} orphaned claim(s)` +
          (abandoned
            ? `, abandoned ${abandoned} past the ${GIVE_UP_AFTER_MS / 3600_000}h cutoff`
            : "") +
          ` (older than ${STUCK_AFTER_MS / 60_000}m)`
      );
    }

    return { requeued, abandoned };
  } catch (err) {
    console.error("[reaper] sweep failed:", err.message);
    return { error: err.message };
  } finally {
    running = false;
  }
};

const startReaper = () => {
  if (!redisEnabled()) return null; // no queue -> nothing to re-enqueue into
  if (timer) return timer;
  timer = setInterval(() => sweep().catch(() => {}), SWEEP_INTERVAL_MS);
  timer.unref?.();
  console.log(`[reaper] started (every ${SWEEP_INTERVAL_MS / 60_000}m)`);
  return timer;
};

const stopReaper = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = { startReaper, stopReaper, sweep };
