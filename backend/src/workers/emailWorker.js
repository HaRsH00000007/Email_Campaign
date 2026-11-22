// Consumes the campaign-email queue: takes one CLAIMED message row and actually
// delivers it.
//
// This is where all the slow, failure-prone work lives -- template render, the
// per-recipient AI rewrite (which can take tens of seconds), the per-mailbox
// rate check, and the provider call. Keeping it here rather than in the
// scheduler's timer is what stops one slow rewrite or one throttled mailbox
// stalling every campaign in the system.
//
// IDEMPOTENCE: the job carries only a messageId. We re-read the row and bail
// unless it is still "queued". So a redelivered job, a double enqueue, a reaper
// re-queue, and a retry after a crash mid-send all converge on "send once".
// This is what turns the queue's at-least-once DELIVERY into exactly-once
// SENDING.
//
// QUOTA: the runner reserves when it CLAIMS. Retries here do not re-reserve. We
// refund only when giving up permanently.

const { DelayedError } = require("bullmq");
const { EmailMessage, EmailCampaign, EmailAccount } = require("../models");
const { sendViaAccount } = require("../services/gmail/sender");
const sendQuota = require("../services/quota/sendQuota");
const { uniquifyEmail } = require("../services/personalization/uniquifier");
const { render, toEmailHtml, toText } = require("../services/personalization/templating");
const {
  resolveFollowupSteps,
  senderAccounts,
  pickTemplate,
  fieldsToObject,
} = require("../services/campaigns/runner");
const {
  tryConsume,
  release,
  cooldown,
  limitsFor,
} = require("../services/rateLimit/mailboxLimiter");
const { createEmailWorker, deadLetter, MAX_ATTEMPTS } = require("../services/queue/emailQueue");
const { isEnabled: redisEnabled } = require("../services/queue/client");

let worker = null;

const MAX_PARK_MS = 6 * 3600_000;

// How long to re-park a job the mailbox would not let through.
//
// The jitter is load-bearing, not decoration. With N jobs queued for one
// mailbox, a bare retryAfterMs wakes all N at the same millisecond; one wins
// the spacing check and N-1 immediately re-park, and that thundering herd
// repeats on every slot. Spreading the wake-ups over a short window turns an
// O(N) stampede per send into roughly one contender per slot. We always wait at
// least the full retryAfterMs -- jitter is added, never subtracted, so it can
// never shorten the spacing guarantee.
const reparkDelay = (retryAfterMs) => {
  const base = Math.min(Math.max(Number(retryAfterMs) || 60_000, 1), MAX_PARK_MS);
  const jitter = Math.floor(Math.random() * Math.min(5_000, Math.max(250, base * 0.1)));
  return base + jitter;
};

// Build the subject and HTML for a claimed row. Pitch rows pick a variant;
// follow-up rows resolve their step. Both are optionally rewritten per
// recipient.
const composeEmail = async (msg, campaign) => {
  const fields = fieldsToObject(msg.fields);

  let rendered;
  let templateIndex = null;

  if (msg.stage === "followup") {
    const steps = resolveFollowupSteps(campaign);
    const step = steps[msg.followupStep ?? 0];
    if (!step) return null; // the sequence changed under us -- nothing to send

    rendered = {
      // A blank step subject inherits the pitch subject so it threads naturally
      // in the recipient's client.
      subject: render(step.subject || campaign.pitches?.[0]?.subject || "", msg.fields),
      body: render(step.html, msg.fields),
    };
  } else {
    const { tpl, index } = pickTemplate(campaign.pitches);
    if (!tpl) return null;
    templateIndex = index;
    rendered = {
      subject: render(tpl.subject, msg.fields),
      body: render(tpl.html, msg.fields),
    };
  }

  const { subject, body } = campaign.uniqueEmails
    ? await uniquifyEmail({ ...rendered, leadEmail: msg.leadEmail, fields })
    : rendered;

  return { subject, html: toEmailHtml(body), templateIndex };
};

// A follow-up must go out in the pitch's thread, from the same mailbox.
const parentThreadIdFor = async (msg) => {
  if (msg.stage !== "followup") return undefined;
  const pitch = await EmailMessage.findOne({
    campaignId: msg.campaignId,
    leadEmail: msg.leadEmail,
    stage: "pitch",
    status: { $in: ["sent", "replied", "auto_reply"] },
  })
    .select("threadId")
    .lean();
  return pitch?.threadId || undefined;
};

// Record a permanent failure: mark the row, return the quota, and dead-letter
// the job so the drop is VISIBLE and replayable rather than silently vanishing.
const failPermanently = async (msg, error, meta = {}) => {
  await EmailMessage.updateOne(
    { _id: msg._id },
    { status: "failed", error: String(error).slice(0, 500) }
  ).catch(() => {});

  await sendQuota.refund(msg.userId, { campaignId: msg.campaignId }).catch(() => {});

  await deadLetter(msg._id, String(error).slice(0, 500), {
    campaignId: String(msg.campaignId),
    leadEmail: msg.leadEmail,
    stage: msg.stage,
    ...meta,
  }).catch(() => {});

  console.warn(
    `[worker] PERMANENT FAIL msg=${msg._id} lead=${msg.leadEmail} stage=${msg.stage}: ${error}`
  );
};

const processEmailJob = async (job, token) => {
  const { messageId } = job.data || {};
  if (!messageId) return { skipped: "no_message_id" };

  const msg = await EmailMessage.findById(messageId);
  // Row gone (campaign deleted, recipient removed) -- nothing to do.
  if (!msg) return { skipped: "row_missing" };

  // THE IDEMPOTENCE GATE. Anything not still "queued" has already been decided.
  if (msg.status !== "queued") return { skipped: `already_${msg.status}` };

  const campaign = await EmailCampaign.findById(msg.campaignId);
  if (!campaign) {
    await failPermanently(msg, "campaign_deleted");
    return { failed: true };
  }

  // Honour a pause that happened AFTER this job was enqueued. Do not burn an
  // attempt -- just hold the job and look again later.
  if (campaign.status !== "active") {
    await job.moveToDelayed(Date.now() + 60_000, token);
    throw new DelayedError();
  }

  const accountId = msg.sendingAccountId || senderAccounts(campaign)[0];
  if (!accountId) {
    await failPermanently(msg, "no_sending_account");
    return { failed: true };
  }

  // -- Per-mailbox pacing ----------------------------------------------------
  // Ask the mailbox for a send slot. A denial means one of: the 60s spacing has
  // not elapsed, an optional hourly ceiling is full, or Google has put this
  // mailbox on a cooldown. In every case PARK the job rather than failing it.
  //
  // Crucially this does NOT consume a retry attempt. Being paced is not a
  // failure -- a mailbox under a long cooldown would otherwise exhaust all its
  // attempts in minutes and dead-letter a perfectly good email.
  const account = await EmailAccount.findById(accountId)
    .select("hourlyLimit minSpacingMs")
    .lean();
  const slot = await tryConsume(accountId, limitsFor(account));
  if (!slot.ok) {
    await job.moveToDelayed(Date.now() + reparkDelay(slot.retryAfterMs), token);
    throw new DelayedError();
  }

  // From here on we HOLD a mailbox token. Any path that does not send must
  // release it, or we leak quota and under-send for the rest of the window.
  let composed;
  try {
    composed = await composeEmail(msg, campaign);
  } catch (e) {
    await release(accountId);
    throw e; // treat a compose crash as transient; BullMQ will retry
  }

  if (!composed) {
    await release(accountId);
    await failPermanently(msg, "template_missing");
    return { failed: true };
  }

  const threadId = await parentThreadIdFor(msg);

  const result = await sendViaAccount({
    accountId,
    to: msg.leadEmail,
    subject: composed.subject,
    html: composed.html,
    text: toText(composed.html),
    threadId,
  });

  if (result.ok) {
    await EmailMessage.updateOne(
      { _id: msg._id },
      {
        status: "sent",
        subject: composed.subject,
        bodyHtml: composed.html,
        gmailMessageId: result.id || "",
        threadId: result.threadId || threadId || "",
        sentAt: new Date(),
        error: "",
        ...(composed.templateIndex != null ? { templateIndex: composed.templateIndex } : {}),
      }
    ).catch(() => {});

    // NOTE: progress.totalSent / sentToday are incremented by the RUNNER at
    // enqueue time, not here. Those counters drive pacing (how much the
    // scheduler may commit in a window), so they must reflect what has been
    // handed to the queue. Incrementing again here would double-count.
    return { sent: true };
  }

  // -- Failed. Retry, or give up? -------------------------------------------
  // We did not send, so hand the mailbox slot back either way.
  await release(accountId);

  // GOOGLE SAID SLOW DOWN. This is the one restriction we must never try to
  // out-wait by retrying harder. Park the WHOLE mailbox on a shared cooldown so
  // every other worker and every other campaign using it defers on the same
  // clock, then re-park this job without burning an attempt -- a send-limit
  // trip can last many minutes, and spending all five attempts discovering that
  // would dead-letter a perfectly deliverable email.
  //
  // This is a DEFERRAL, not a bypass: the cooldown length comes from Google's
  // own Retry-After when it sent one.
  if (result.rateLimited) {
    const waitMs = Math.min(result.retryAfterMs || 15 * 60_000, MAX_PARK_MS);
    await cooldown(accountId, waitMs, `gmail_${result.status ?? "rate_limit"}`);
    console.warn(
      `[worker] mailbox=${accountId} throttled by Gmail ` +
        `(status=${result.status ?? "n/a"}): deferring ${Math.round(waitMs / 1000)}s -- ${result.error}`
    );
    await job.moveToDelayed(Date.now() + reparkDelay(waitMs), token);
    throw new DelayedError();
  }

  const attemptsSoFar = (job.attemptsMade ?? 0) + 1;
  const lastAttempt = attemptsSoFar >= MAX_ATTEMPTS;

  if (result.retryable && !lastAttempt) {
    // Throwing hands it back to BullMQ, which re-queues with exponential
    // backoff. The row stays "queued", so the idempotence gate lets the retry
    // through.
    throw new Error(`send_failed: ${result.error} (status=${result.status ?? "n/a"})`);
  }

  await failPermanently(msg, result.error || "send_failed", {
    status: result.status,
    retryable: result.retryable,
    attempts: attemptsSoFar,
  });
  return { failed: true };
};

const startEmailWorker = () => {
  if (!redisEnabled()) {
    console.warn(
      "[worker] REDIS_URL is not set -- the send worker is DISABLED and no " +
        "campaign email can be delivered. Set REDIS_URL."
    );
    return null;
  }
  if (worker) return worker;

  worker = createEmailWorker(processEmailJob);
  worker.on("failed", (job, err) => {
    // A DelayedError is the parking mechanism, not a failure. Do not log it as
    // one, or a rate-limited mailbox fills the log with false alarms.
    if (err instanceof DelayedError || err?.name === "DelayedError") return;
    console.error(
      `[worker] job=${job?.id} attempt=${job?.attemptsMade}/${MAX_ATTEMPTS} failed: ${err?.message}`
    );
  });

  console.log("[worker] started");
  return worker;
};

const stopEmailWorker = async () => {
  if (worker) {
    await worker.close().catch(() => {});
    worker = null;
  }
};

module.exports = {
  startEmailWorker,
  stopEmailWorker,
  processEmailJob,
  composeEmail,
  reparkDelay,
};
