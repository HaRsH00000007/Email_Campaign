// Inspect and replay the dead-letter queue.
//
//   node scripts/emailDlq.js               list dead jobs
//   node scripts/emailDlq.js --replay      re-enqueue every dead job
//   node scripts/emailDlq.js --purge       clear the DLQ
//
// A job lands in the DLQ when it exhausted its retries or hit a permanent
// error. Nothing consumes the queue -- it exists so a dropped email is VISIBLE
// and replayable rather than silently gone.
//
// Replay is safe: the message row is reset to "queued" first, and the worker's
// idempotence gate plus the unique claim mean a row that actually did send can
// never send twice.

require("dotenv").config();
const { connectDb, disconnectDb } = require("../src/config/db");
const EmailMessage = require("../src/models/emailMessage");
const { getEmailDlq, enqueueEmail } = require("../src/services/queue/emailQueue");
const { isEnabled } = require("../src/services/queue/client");
const { closeRedis } = require("../src/services/queue/client");

const REPLAY = process.argv.includes("--replay");
const PURGE = process.argv.includes("--purge");

const main = async () => {
  if (!isEnabled()) {
    console.error("REDIS_URL is not set -- there is no queue to inspect.");
    process.exit(1);
  }

  await connectDb();
  const dlq = getEmailDlq();
  const jobs = await dlq.getJobs(["waiting", "delayed", "completed", "failed"], 0, 500);

  if (!jobs.length) {
    console.log("\nDead-letter queue is empty.\n");
    await closeRedis();
    await disconnectDb();
    return;
  }

  console.log(`\n${jobs.length} dead job(s):\n`);
  for (const j of jobs) {
    const d = j.data || {};
    console.log(
      `  ${d.deadAt || "?"}  ${d.leadEmail || "?"}  ${d.stage || "?"}  msg=${d.messageId}\n` +
        `      reason: ${d.reason}`
    );
  }

  if (PURGE) {
    await dlq.obliterate({ force: true });
    console.log(`\nPurged ${jobs.length} job(s).\n`);
  } else if (REPLAY) {
    let replayed = 0;
    let skipped = 0;

    for (const j of jobs) {
      const id = j.data?.messageId;
      if (!id) continue;

      const msg = await EmailMessage.findById(id);
      if (!msg) {
        skipped += 1;
        continue;
      }
      // Only a failed row is worth replaying. Anything already delivered or
      // resolved is left alone.
      if (msg.status !== "failed") {
        skipped += 1;
        continue;
      }

      await EmailMessage.updateOne({ _id: id }, { status: "queued", error: "" });
      await enqueueEmail(id);
      await j.remove().catch(() => {});
      replayed += 1;
    }

    console.log(`\nReplayed ${replayed}, skipped ${skipped} (already resolved or gone).\n`);
  } else {
    console.log("\nRe-run with --replay to re-enqueue, or --purge to clear.\n");
  }

  await closeRedis();
  await disconnectDb();
};

main().catch((err) => {
  console.error("failed:", err);
  process.exit(1);
});
