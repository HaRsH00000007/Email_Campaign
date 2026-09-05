// BullMQ queue for outbound campaign emails.
//
// JOB SHAPE -- deliberately just an ID, never the message body:
//   { messageId }   the EmailMessage._id of a row already claimed as "queued"
//
// The EmailMessage row IS the job record. The runner claims a lead by inserting
// that row (protected by a unique partial index) and only then enqueues. So:
//
//   - the claim is the idempotency key: a duplicate job is a no-op, because the
//     worker re-reads the row and skips anything not still "queued";
//   - the payload cannot go stale, because there is no payload;
//   - at-least-once delivery FROM the queue yields exactly-once SENDING.
//
// PORTABILITY: this is the seam where BullMQ would be swapped for SQS, Pub/Sub
// or anything else. Callers only ever see enqueueEmail() / createEmailWorker(),
// never a BullMQ type, so the transport can change without touching the runner
// or the worker body.

const { Queue, Worker } = require("bullmq");
const { createConnection, isEnabled } = require("./client");
const { env, num } = require("../../config/env");

const EMAIL_QUEUE_NAME = env("EMAIL_QUEUE_NAME", "campaign-emails");
const EMAIL_DLQ_NAME = `${EMAIL_QUEUE_NAME}-dead`;

// How many times to try a transient failure before giving up. Deliberately
// generous: a mailbox over quota can 429 for a long while, an email is not
// time-critical the way a ringing phone is, and re-sending an hour later is
// still a successful send.
const MAX_ATTEMPTS = num("EMAIL_MAX_ATTEMPTS", 5);

let queue = null;
let dlq = null;

const getEmailQueue = () => {
  if (!isEnabled()) return null;
  if (queue) return queue;

  queue = new Queue(EMAIL_QUEUE_NAME, {
    connection: createConnection(),
    defaultJobOptions: {
      attempts: MAX_ATTEMPTS,
      // Exponential from 30s: ~30s, 1m, 2m, 4m. A rate-limited mailbox needs
      // real time to recover -- retrying in a second or two would just burn
      // attempts against a quota that has not moved.
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 3600, count: 1000 },
      // Keep failures far longer than successes -- they are what you debug.
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });

  queue.on("error", (err) => console.error(`[queue:${EMAIL_QUEUE_NAME}]`, err.message));
  return queue;
};

// Dead-letter queue. A job lands here once it exhausts MAX_ATTEMPTS, or
// immediately on a permanent error. Nothing consumes it: it exists so a dropped
// email is VISIBLE and replayable instead of vanishing. Inspect with
// scripts/emailDlq.js.
const getEmailDlq = () => {
  if (!isEnabled()) return null;
  if (dlq) return dlq;
  dlq = new Queue(EMAIL_DLQ_NAME, {
    connection: createConnection(),
    defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
  });
  dlq.on("error", (err) => console.error(`[queue:${EMAIL_DLQ_NAME}]`, err.message));
  return dlq;
};

// Enqueue one claimed EmailMessage.
//
// jobId is the messageId, so BullMQ itself de-duplicates: enqueueing the same
// claimed row twice (a retried scheduler tick, a double-clicked button, the
// reaper re-queueing a job that was merely parked) produces one job, not two.
const enqueueEmail = async (messageId, opts = {}) => {
  const q = getEmailQueue();
  if (!q) return null;
  return q.add("send", { messageId: String(messageId) }, { jobId: String(messageId), ...opts });
};

const deadLetter = async (messageId, reason, meta = {}) => {
  const d = getEmailDlq();
  if (!d) return null;
  return d.add("dead", {
    messageId: String(messageId),
    reason,
    ...meta,
    deadAt: new Date().toISOString(),
  });
};

const createEmailWorker = (processor, opts = {}) => {
  if (!isEnabled()) return null;
  const worker = new Worker(EMAIL_QUEUE_NAME, processor, {
    connection: createConnection(),
    // Modest concurrency. The real throughput limiter is the per-mailbox token
    // bucket, not this number -- set it high enough that jobs for DIFFERENT
    // mailboxes proceed in parallel, low enough not to hold hundreds of Mongo
    // connections open.
    concurrency: num("EMAIL_WORKER_CONCURRENCY", opts.concurrency || 20),
  });
  worker.on("error", (err) => console.error(`[worker:${EMAIL_QUEUE_NAME}]`, err.message));
  return worker;
};

// Queue depth, for the health endpoint and the dashboard.
const queueCounts = async () => {
  const q = getEmailQueue();
  if (!q) return null;
  try {
    const counts = await q.getJobCounts("waiting", "active", "delayed", "failed", "completed");
    const d = getEmailDlq();
    const dead = d ? await d.getJobCounts("waiting") : { waiting: 0 };
    return { ...counts, dead: dead.waiting || 0 };
  } catch {
    return null;
  }
};

module.exports = {
  getEmailQueue,
  getEmailDlq,
  enqueueEmail,
  deadLetter,
  createEmailWorker,
  queueCounts,
  EMAIL_QUEUE_NAME,
  EMAIL_DLQ_NAME,
  MAX_ATTEMPTS,
};
