// The campaign scheduler: two timers behind a Redis leader lock.
//
//   TICK  (30s) - per campaign: release spread batches or claim rate-mode
//                 pitches, advance follow-ups, run the reply safety net,
//                 recompute stats, detect completion. Then, ONCE PER MAILBOX,
//                 run the history sync.
//   SEND  (5s)  - drain released spread batches one email at a time, honouring
//                 the random inter-send gap. Fine-grained so the micro-spacing
//                 stays believable; each wake claims at most one email per
//                 campaign so the loop never blocks.
//
// The leader lock stops two instances both ticking every campaign. It is NOT
// what prevents duplicate sends -- the unique-index claim does that, and it
// holds even with the lock disabled. What the lock prevents is duplicated work
// and pacing counters advancing twice as fast as intended.

const { EmailCampaign, EmailMessage } = require("../../models");
const {
  sendPitchBatch,
  sendOnePitch,
  sendFollowupBatch,
  resolveFollowupSteps,
  senderAccounts,
} = require("./runner");
const { syncCampaignReplies } = require("../replies/replySync");
const { syncAllAccounts } = require("../replies/historySync");
const { recomputeCampaignStats } = require("./stats");
const { getLeadCount } = require("./leadCount");
const { acquireLock, renewLock, releaseLock } = require("../queue/lock");
const { isEnabled: redisEnabled } = require("../queue/client");
const { normalizePacing, computeSchedule, jitterMs, HOUR_MS } = require("./pacing");
const { num } = require("../../config/env");

const TICK_INTERVAL_MS = num("SCHEDULER_TICK_MS", 30_000);
const SEND_TICK_MS = num("SCHEDULER_SEND_TICK_MS", 5_000);
const LEADER_LOCK_KEY = "scheduler:email:leader";
const LEADER_TTL_MS = TICK_INTERVAL_MS * 3;
const MAX_ACTIVE_PER_TICK = 200;

// Thread-poll budget per campaign per tick -- the SAFETY NET, not the main
// path. Reply detection runs primarily off the history API (one call per
// MAILBOX per tick, independent of lifetime volume). This poller only covers
// what history cannot: mail that arrived before a mailbox was first synced, and
// gaps after a cursor goes stale. A small number is all it needs to be.
const REPLY_POLL_BUDGET = num("EMAIL_REPLY_POLL_BUDGET", 5);

let timer = null;
let sendTimer = null;
let running = false;
let sending = false;
let leaderToken = null;

const ensureLeader = async () => {
  if (!redisEnabled()) return true; // single-node: always leader
  if (leaderToken) {
    const renewed = await renewLock(LEADER_LOCK_KEY, leaderToken, LEADER_TTL_MS);
    if (renewed) return true;
    leaderToken = null;
  }
  leaderToken = await acquireLock(LEADER_LOCK_KEY, LEADER_TTL_MS);
  if (leaderToken) console.log("[scheduler] acquired leader lock");
  return !!leaderToken;
};

const todayKey = () => new Date().toISOString().slice(0, 10);
const isSpread = (campaign) => campaign.pacing?.mode === "spread";

// Release spread-mode batches: when the interval has elapsed, top up
// batchRemaining with one batch's worth of leads (capped at what is left).
// The fast send loop then drains it with per-send jitter. MUTATES
// campaign.progress; the caller saves.
const releaseSpreadBatches = (campaign, totalLeads, now) => {
  const p = campaign.progress;

  // A zero lead count would make leadsPerBatch 0 and CLAMP batchRemaining to 0,
  // silently throwing away a batch that was already released. Since the count
  // read can come back 0 transiently, that turns a blip into a stall lasting a
  // whole interval -- 24h on a one-batch-a-day campaign. Never let a 0 reading
  // mutate progress: leave the staged batch alone and re-read next tick.
  if (!totalLeads) {
    console.warn(`[scheduler] ${campaign.name}: lead count read 0 -- batch state untouched`);
    return;
  }

  const pacing = normalizePacing(campaign.pacing);
  const mailboxCount = senderAccounts(campaign).length || 1;
  const sched = computeSchedule(totalLeads, pacing, mailboxCount);
  p.leadsPerBatch = sched.leadsPerBatch;

  // First tick after launch: release the opening batch immediately.
  if (!p.nextBatchAt) p.nextBatchAt = new Date(now);

  const intervalMs = pacing.intervalHours * HOUR_MS;
  const remainingLeads = Math.max(0, totalLeads - (p.nextLeadIndex || 0));
  let released = 0;

  // Catch up on intervals that elapsed while the process was down, but never
  // stage more than the leads that actually remain.
  while (
    new Date(p.nextBatchAt).getTime() <= now &&
    (p.batchRemaining || 0) + released < remainingLeads
  ) {
    released += sched.leadsPerBatch;
    p.nextBatchAt = new Date(new Date(p.nextBatchAt).getTime() + intervalMs);
  }

  if (released > 0) {
    p.batchRemaining = Math.min(remainingLeads, (p.batchRemaining || 0) + released);
  } else {
    // Keep batchRemaining from exceeding what is left (the list may have shrunk).
    p.batchRemaining = Math.min(p.batchRemaining || 0, remainingLeads);
  }
};

// Has every non-replier been walked through the WHOLE follow-up sequence?
const followupsPendingCount = async (campaign, steps) => {
  if (!steps.length) return 0;

  const pitches = await EmailMessage.find({
    campaignId: campaign._id,
    stage: "pitch",
    status: "sent",
  }).select("leadEmail");

  const fuRows = await EmailMessage.find({
    campaignId: campaign._id,
    stage: "followup",
  }).select("leadEmail status");

  const counts = new Map();
  const replied = new Set();
  for (const f of fuRows) {
    counts.set(f.leadEmail, (counts.get(f.leadEmail) || 0) + 1);
    if (f.status === "replied") replied.add(f.leadEmail);
  }

  // A non-replier with fewer follow-up rows than there are steps still has
  // sequence left to send -- now, or once their next delay elapses.
  return pitches.filter(
    (p) => !replied.has(p.leadEmail) && (counts.get(p.leadEmail) || 0) < steps.length
  ).length;
};

const tickCampaign = async (campaign) => {
  // Daily counter reset.
  const day = todayKey();
  if (campaign.progress.dayKey !== day) {
    campaign.progress.dayKey = day;
    campaign.progress.sentToday = 0;
  }
  campaign.progress.lastTickAt = new Date();

  let pitched = 0;

  if (isSpread(campaign)) {
    // The fast send loop does the pitching. Here we only release due batches so
    // it has work to drain.
    releaseSpreadBatches(campaign, await getLeadCount(campaign.leadListId), Date.now());
    await campaign.save().catch(() => {});
  } else {
    // Rate mode: per-tick cap from the per-minute rate, bounded by the
    // remaining daily allowance.
    const perTick = Math.max(
      1,
      Math.round((campaign.sendRatePerMin || 20) * (TICK_INTERVAL_MS / 60000))
    );
    const dailyRemaining = Math.max(
      0,
      (campaign.dailyLimit || 500) - (campaign.progress.sentToday || 0)
    );
    const budget = Math.min(perTick, dailyRemaining);

    if (budget > 0) {
      const r = await sendPitchBatch(campaign, budget);
      pitched = r.sent;
      if (r.quotaDenied) console.log(`[scheduler] ${campaign.name}: paused -- send quota denied`);
    }
  }

  // Follow-ups. Throughput per tick is independent of the pitch pacing mode.
  let followups = 0;
  if (campaign.followup?.enabled) {
    const max = Math.max(
      1,
      Math.round((campaign.sendRatePerMin || 20) * (TICK_INTERVAL_MS / 60000))
    );
    followups = await sendFollowupBatch(campaign, { ignoreDelay: false, max });
  }

  // Reply safety net + stats.
  await syncCampaignReplies(campaign, { limit: REPLY_POLL_BUDGET }).catch(() => {});
  await recomputeCampaignStats(campaign._id).catch(() => {});

  // Completion: every lead pitched, and either follow-ups are off or every
  // non-replier has finished the sequence.
  const totalLeads = await getLeadCount(campaign.leadListId);
  const allPitched = (campaign.progress.nextLeadIndex || 0) >= totalLeads && totalLeads > 0;

  if (allPitched) {
    const steps = campaign.followup?.enabled ? resolveFollowupSteps(campaign) : [];
    const pending = await followupsPendingCount(campaign, steps);

    if (pending === 0) {
      // Do not declare completion while claims are still in flight -- a queued
      // row has not been delivered yet, and marking the campaign complete would
      // make the worker's pause check park those jobs for a minute at a time.
      const inFlight = await EmailMessage.countDocuments({
        campaignId: campaign._id,
        status: "queued",
      });
      if (inFlight === 0) {
        campaign.status = "completed";
        await campaign.save().catch(() => {});
        console.log(`[scheduler] ${campaign.name}: completed`);
      }
    }
  }

  return { pitched, followups };
};

const runTick = async () => {
  if (running) return;

  const isLeader = await ensureLeader().catch((err) => {
    console.error("[scheduler] leader-lock error:", err.message);
    return false;
  });
  if (!isLeader) return;

  running = true;
  try {
    const active = await EmailCampaign.find({ status: "active" }).limit(MAX_ACTIVE_PER_TICK);
    if (!active.length) return;

    for (const campaign of active) {
      // Sequential per campaign is fine -- each tick's work is small and bounded.
      try {
        const r = await tickCampaign(campaign);
        if (r.pitched || r.followups) {
          console.log(
            `[scheduler] ${campaign.name}: pitched ${r.pitched}, follow-ups ${r.followups}`
          );
        }
      } catch (err) {
        console.error(`[scheduler] ${campaign.name} tick error:`, err.message);
      }
    }

    // -- Reply detection, ONCE PER MAILBOX -----------------------------------
    // Deliberately outside the per-campaign loop. Replies arrive in a MAILBOX,
    // not a campaign, and several campaigns commonly share one -- so syncing per
    // campaign would re-scan the same inbox N times. One history call per
    // distinct mailbox tells us everything new across every campaign sending
    // from it.
    const mailboxes = [...new Set(active.flatMap((c) => senderAccounts(c).map(String)))];
    if (mailboxes.length) {
      try {
        const r = await syncAllAccounts(mailboxes);
        if (r.newReplies) {
          console.log(
            `[scheduler] history sync: ${r.newReplies} new ` +
              `repl${r.newReplies === 1 ? "y" : "ies"} across ${r.mailboxes} mailbox(es)`
          );
        }
      } catch (err) {
        console.error("[scheduler] history sync error:", err.message);
      }
    }
  } catch (err) {
    console.error("[scheduler] tick loop error:", err.message);
  } finally {
    running = false;
  }
};

// Fast send loop -- drains spread-mode batches one email at a time.
const runSendTick = async () => {
  if (sending) return;
  // Only the leader sends. We do not acquire here: the 30s tick owns the lock
  // and renews it; this loop honours whatever it established.
  if (redisEnabled() && !leaderToken) return;

  sending = true;
  try {
    const active = await EmailCampaign.find({
      status: "active",
      "pacing.mode": "spread",
    }).limit(MAX_ACTIVE_PER_TICK);

    const now = Date.now();

    for (const campaign of active) {
      try {
        if ((campaign.progress.batchRemaining || 0) <= 0) continue; // nothing released
        const nextAt = campaign.progress.nextSendAt
          ? new Date(campaign.progress.nextSendAt).getTime()
          : 0;
        if (now < nextAt) continue; // honour the inter-send gap

        const r = await sendOnePitch(campaign);

        if (r.done) {
          // Genuinely exhausted: the cursor reached the end of the list. ONLY
          // this drops the staged batch.
          console.log(`[scheduler] ${campaign.name}: list exhausted, clearing staged batch`);
          campaign.progress.batchRemaining = 0;
          await campaign.save().catch(() => {});
          continue;
        }

        // List momentarily unreadable or empty -- keep the batch staged and
        // retry next wake, rather than discarding a whole interval of sends.
        if (r.noLeads) {
          console.warn(`[scheduler] ${campaign.name}: list read 0 leads -- batch stays staged`);
          continue;
        }
        if (r.noAccounts) continue;
        if (r.quotaDenied || r.queueUnavailable) continue; // batch stays staged

        if (!r.sent) {
          // Say what happened. A stalled campaign otherwise looks identical to
          // an idle one in the logs.
          console.warn(
            `[scheduler] ${campaign.name}: send skipped (${r.skipped ? "already claimed" : "no-op"})`
          );
        }

        // Consumed one from the batch; schedule the next after a random gap.
        const gap = jitterMs(campaign.pacing);
        campaign.progress.batchRemaining = Math.max(
          0,
          (campaign.progress.batchRemaining || 0) - 1
        );
        campaign.progress.nextSendAt = new Date(now + gap);
        await campaign.save().catch(() => {});

        if (r.sent) {
          console.log(
            `[scheduler] ${campaign.name}: queued 1 ` +
              `(${campaign.progress.batchRemaining} left in batch, next in ${Math.round(gap / 1000)}s)`
          );
        }
      } catch (err) {
        console.error(`[scheduler] ${campaign.name} send error:`, err.message);
      }
    }
  } catch (err) {
    console.error("[scheduler] send loop error:", err.message);
  } finally {
    sending = false;
  }
};

const startScheduler = () => {
  if (timer) return;
  console.log(`[scheduler] starting (tick=${TICK_INTERVAL_MS}ms, send=${SEND_TICK_MS}ms)`);
  runTick().catch(() => {});
  timer = setInterval(() => runTick().catch(() => {}), TICK_INTERVAL_MS);
  timer.unref?.();
  sendTimer = setInterval(() => runSendTick().catch(() => {}), SEND_TICK_MS);
  sendTimer.unref?.();
};

const stopScheduler = async () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (sendTimer) {
    clearInterval(sendTimer);
    sendTimer = null;
  }
  if (leaderToken) {
    await releaseLock(LEADER_LOCK_KEY, leaderToken).catch(() => {});
    leaderToken = null;
  }
};

module.exports = { startScheduler, stopScheduler, runTick, runSendTick, TICK_INTERVAL_MS };
