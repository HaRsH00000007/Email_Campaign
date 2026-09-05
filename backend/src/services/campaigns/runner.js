// Core send logic, shared by the scheduler (throttled, time-gated) and the
// manual "follow up now" endpoint (immediate).
//
// This file CLAIMS and ENQUEUES. It does not send. The split matters: rendering,
// AI rewriting, rate-limit checks and the provider call are all slow and
// failure-prone, and running them inline inside a scheduler timer means one
// slow rewrite or one throttled mailbox stalls every campaign in the system.
//
//   sendPitchBatch    - claim the next N first-pitch emails (rate mode)
//   sendOnePitch      - claim exactly one, rotating mailboxes (spread mode)
//   sendFollowupBatch - walk pitched-but-unreplied leads one step at a time
//                       through the follow-up SEQUENCE
//
// THE CLAIM. Each of these inserts an EmailMessage row with status "queued"
// BEFORE handing anything to the queue. The unique partial indexes on that
// collection make the insert the atomic act of taking ownership of a lead: a
// racing worker, a restarted process, or a duplicate address in the uploaded
// file all lose with E11000 and skip. Nothing anywhere asks "have I already
// sent this?" -- a question two concurrent workers can both answer "no".
//
// Three ordered steps, each rolling back the ones before it on failure:
//   1. CLAIM   insert the row            -> on dup: skip, advance cursor
//   2. RESERVE send quota (no-op default)-> on deny: delete row, HOLD cursor
//   3. ENQUEUE hand to the queue         -> on fail: delete row, refund, HOLD

const { EmailLead, EmailMessage } = require("../../models");
const { getLeadCount } = require("./leadCount");
const { enqueueEmail } = require("../queue/emailQueue");
const sendQuota = require("../quota/sendQuota");
const { DAY_MS, HOUR_MS } = require("./pacing");

// -- Template selection ------------------------------------------------------

// Pick a pitch variant for one send. With several variants we choose uniformly
// at random per lead, so the list splits across them. Returns { tpl, index }.
const pickTemplate = (templates) => {
  const valid = (Array.isArray(templates) ? templates : []).filter(
    (t) => t && (t.subject || t.html)
  );
  if (!valid.length) return { tpl: null, index: null };
  const i = Math.floor(Math.random() * valid.length);
  return { tpl: valid[i], index: i };
};

// Normalize the follow-up config into an ordered list of { delayMs, subject,
// html }. `delayMs` is how long to wait AFTER the previous email.
const resolveFollowupSteps = (campaign) => {
  const steps = Array.isArray(campaign.followup?.steps) ? campaign.followup.steps : [];
  return steps
    .map((s) => ({
      delayMs: Math.max(
        0,
        (Number(s?.delayDays) || 0) * DAY_MS + (Number(s?.delayHours) || 0) * HOUR_MS
      ),
      subject: String(s?.subject || ""),
      html: String(s?.html || ""),
    }))
    .filter((s) => s.subject.trim() || s.html.trim());
};

// The ordered mailboxes a campaign sends from.
const senderAccounts = (campaign) =>
  (Array.isArray(campaign.emailAccountIds) ? campaign.emailAccountIds : [])
    .map((x) => (x && x._id ? x._id : x))
    .filter(Boolean);

// -- Lead access -------------------------------------------------------------

// Random access into a lead list without loading it.
//
// Leads are their own documents (a large list would exceed MongoDB's 16MB
// document cap if embedded), so this stands in for what used to be an array
// subscript: `total` is the length, `getAt(i)` is `leads[i]`.
//
// Callers that will walk a RUN of leads pass a prefetch window, so one query
// covers the whole batch instead of one query per send. getAt falls back to a
// point read for anything outside it.
const makeLeadSource = async (leadListId, { from = 0, count = 0 } = {}) => {
  const total = await getLeadCount(leadListId);
  const cache = new Map();

  if (count > 0 && total > 0) {
    const window = await EmailLead.find({
      listId: leadListId,
      idx: { $gte: from, $lt: from + count },
    })
      .sort({ idx: 1 })
      .lean();
    for (const l of window) cache.set(l.idx, l);
  }

  return {
    total,
    getAt: async (idx) => {
      if (cache.has(idx)) return cache.get(idx);
      const l = await EmailLead.findOne({ listId: leadListId, idx }).lean();
      if (l) cache.set(idx, l);
      return l;
    },
  };
};

// Mongoose Map -> plain object, for the snapshot stored on the message row.
const fieldsToObject = (fields) => {
  if (!fields) return {};
  if (typeof fields.entries === "function" && typeof fields.get === "function") {
    return Object.fromEntries(fields.entries());
  }
  return { ...fields };
};

// -- Pitch sending -----------------------------------------------------------

// Claim and enqueue ONE first-pitch email to the lead at progress.nextLeadIndex,
// from the given mailbox. Returns:
//   { sent:true }                     - handed to the queue
//   { sent:false, done:true }         - no leads left to pitch
//   { sent:false, noLeads:true }      - list read as empty; DO NOT treat as done
//   { sent:false, skipped:true }      - lead already claimed elsewhere / dup
//   { sent:false, quotaDenied:true }  - quota said no; cursor NOT advanced
//   { sent:false, queueUnavailable:true } - no queue; cursor NOT advanced
const claimAndEnqueuePitch = async (campaign, accountId, source) => {
  const total = source?.total || 0;
  let idx = campaign.progress.nextLeadIndex || 0;

  // Skip rows without an address so we always land on a real send (or the end).
  // A MISSING document counts as blank too: idx is dense for lists written by
  // the importer, but skipping rather than stalling keeps a gap from wedging a
  // campaign forever.
  let lead = null;
  while (idx < total) {
    lead = await source.getAt(idx);
    if (lead?.email) break;
    lead = null;
    idx += 1;
  }
  if (idx >= total || !lead) {
    campaign.progress.nextLeadIndex = idx;
    return { sent: false, done: true };
  }

  const leadEmail = String(lead.email).toLowerCase().trim();

  // 1) CLAIM.
  let claim;
  try {
    claim = await EmailMessage.create({
      campaignId: campaign._id,
      userId: campaign.userId,
      leadEmail,
      fields: fieldsToObject(lead.fields),
      stage: "pitch",
      status: "queued",
      sendingAccountId: accountId,
    });
  } catch (e) {
    if (e && e.code === 11000) {
      // Someone else owns this lead, or the address appears twice in the list.
      campaign.progress.nextLeadIndex = idx + 1;
      return { sent: false, skipped: true };
    }
    throw e;
  }

  // 2) RESERVE. Only after we own the claim. A denial rolls the claim back and
  //    HOLDS the cursor, so the lead is retried rather than consumed.
  const allowed = await sendQuota.reserve(campaign.userId, {
    campaignId: campaign._id,
    stage: "pitch",
  });
  if (!allowed) {
    await EmailMessage.deleteOne({ _id: claim._id }).catch(() => {});
    campaign.progress.nextLeadIndex = idx;
    return { sent: false, quotaDenied: true };
  }

  // 3) ENQUEUE. The claimed row IS the job; the worker does the render, the
  //    rewrite, the rate check and the provider call.
  const queued = await enqueueEmail(claim._id);
  if (!queued) {
    // No queue means we cannot deliver. Roll the claim back rather than marking
    // the lead consumed, so nothing is silently lost: once Redis is configured,
    // this lead is picked up again from exactly here.
    await EmailMessage.deleteOne({ _id: claim._id }).catch(() => {});
    await sendQuota.refund(campaign.userId, { campaignId: campaign._id }).catch(() => {});
    campaign.progress.nextLeadIndex = idx;
    return { sent: false, queueUnavailable: true };
  }

  // The lead is now consumed: it has been handed to the queue, which owns
  // delivery (including retries) from here.
  //
  // Pacing counters tick at ENQUEUE, not on delivery. They exist to stop the
  // scheduler over-committing within a window, so they must count what has been
  // handed over -- waiting for the worker to confirm would let the scheduler
  // keep enqueueing against a stale count and blow the daily limit. Reported
  // stats come from the message rows, so accuracy there is unaffected.
  campaign.progress.nextLeadIndex = idx + 1;
  campaign.progress.totalSent = (campaign.progress.totalSent || 0) + 1;
  campaign.progress.sentToday = (campaign.progress.sentToday || 0) + 1;
  return { sent: true, messageId: claim._id };
};

// Claim exactly ONE pitch, picking the next mailbox round-robin. Used by the
// spread-mode sender, which spaces these out with a random delay.
const sendOnePitch = async (campaign) => {
  const accounts = senderAccounts(campaign);
  if (!accounts.length) return { sent: false, done: false, noAccounts: true };

  const source = await makeLeadSource(campaign.leadListId);

  // A zero count here is NOT "campaign finished". It is an empty list, a missing
  // list, or a transient read -- and treating it as `done` would DISCARD the
  // whole released batch and park the campaign until its next interval. Report
  // it as its own condition so the batch stays staged and we retry.
  if (!source.total) return { sent: false, done: false, noLeads: true };

  const cursor = campaign.progress.acctCursor || 0;
  const accountId = accounts[cursor % accounts.length];

  const r = await claimAndEnqueuePitch(campaign, accountId, source);

  // Advance the mailbox cursor only on an actual send, so a skipped or blank
  // lead does not silently rotate mailboxes and skew the split.
  if (r.sent) campaign.progress.acctCursor = (cursor + 1) % accounts.length;

  await campaign.save().catch(() => {});
  return { ...r, accountId };
};

// Claim the next `max` pitches (rate mode). Returns { sent, quotaDenied }.
const sendPitchBatch = async (campaign, max) => {
  if (max <= 0) return { sent: 0, quotaDenied: false };
  const accounts = senderAccounts(campaign);
  if (!accounts.length) return { sent: 0, quotaDenied: false };

  // We are about to walk up to `max` leads from the cursor, so pull that whole
  // run in one query instead of a point read per send.
  const start = campaign.progress.nextLeadIndex || 0;
  const source = await makeLeadSource(campaign.leadListId, { from: start, count: max });
  if (!source.total) return { sent: 0, quotaDenied: false, noLeads: true };

  let attempts = 0;
  let succeeded = 0;
  let quotaDenied = false;

  while (attempts < max) {
    if ((campaign.progress.nextLeadIndex || 0) >= source.total) break;

    const cursor = campaign.progress.acctCursor || 0;
    const accountId = accounts[cursor % accounts.length];
    const r = await claimAndEnqueuePitch(campaign, accountId, source);

    if (r.done) break;
    if (r.quotaDenied) {
      quotaDenied = true;
      break;
    }
    if (r.queueUnavailable) break;

    attempts += 1;
    if (r.sent) {
      succeeded += 1;
      campaign.progress.acctCursor = (cursor + 1) % accounts.length;
    }
  }

  await campaign.save().catch(() => {});
  return { sent: succeeded, quotaDenied };
};

// -- Follow-ups --------------------------------------------------------------

// Campaigns with a follow-up pass currently running. The scheduler tick and the
// manual "follow up now" button both call sendFollowupBatch; without this guard
// they interleave -- each reading the follow-up rows before the other has
// written its claims -- and every lead gets the same step twice. The unique
// index would catch the duplicate ROW, but this avoids the wasted work and the
// confusing E11000 storm.
const followupInFlight = new Set();

const sendFollowupBatch = async (campaign, { ignoreDelay = false, max = 100 } = {}) => {
  const key = String(campaign._id);
  if (followupInFlight.has(key)) {
    console.warn(`[followup] campaign=${key} already running -- skipping overlapping pass`);
    return 0;
  }
  followupInFlight.add(key);
  try {
    return await runFollowupBatch(campaign, { ignoreDelay, max });
  } finally {
    followupInFlight.delete(key);
  }
};

const runFollowupBatch = async (campaign, { ignoreDelay = false, max = 100 } = {}) => {
  const accounts = senderAccounts(campaign);
  if (!accounts.length) return 0;

  const fallbackAccount = accounts[0];
  const steps = resolveFollowupSteps(campaign);
  if (!steps.length) return 0;

  // Candidate leads: a DELIVERED pitch that has not itself been marked replied.
  // Oldest first, so the leads most likely to be due are visited first.
  const pitchRows = await EmailMessage.find({
    campaignId: campaign._id,
    stage: "pitch",
    status: "sent",
  })
    .select("leadEmail fields sentAt sendingAccountId status")
    .sort({ sentAt: 1 });

  if (!pitchRows.length) return 0;

  // ONE ROW PER LEAD. Even with the unique index in place, a collection that
  // predates it can hold duplicates -- and iterating raw pitch rows would send
  // the whole follow-up sequence once per duplicate.
  const pitches = [];
  const seenLead = new Set();
  for (const p of pitchRows) {
    if (seenLead.has(p.leadEmail)) continue;
    seenLead.add(p.leadEmail);
    pitches.push(p);
  }

  // All follow-up rows, grouped by lead, so we can tell which step each lead is
  // on and whether they have replied to any of them.
  const fuRows = await EmailMessage.find({
    campaignId: campaign._id,
    stage: "followup",
  }).select("leadEmail status followupStep sentAt");

  const fuByLead = new Map();
  for (const f of fuRows) {
    const arr = fuByLead.get(f.leadEmail) || [];
    arr.push(f);
    fuByLead.set(f.leadEmail, arr);
  }

  const now = Date.now();
  let succeeded = 0;

  for (const pitch of pitches) {
    if (succeeded >= max) break;

    // Get-or-create the lead's array IN THE MAP. A throwaway [] here would mean
    // the push below writes into a dead array, and a second visit recomputes
    // nextStep as 0 -- re-sending step 0.
    let prior = fuByLead.get(pitch.leadEmail);
    if (!prior) {
      prior = [];
      fuByLead.set(pitch.leadEmail, prior);
    }
    prior.sort((a, b) => (a.followupStep ?? 0) - (b.followupStep ?? 0));

    // STOP ON REPLY. Any replied row -- pitch or follow-up -- ends the sequence.
    if (pitch.status === "replied") continue;
    if (prior.some((f) => f.status === "replied")) continue;

    // One row exists per attempted step, so the count IS the index of the next
    // step to send.
    const nextStep = prior.length;
    if (nextStep >= steps.length) continue; // sequence complete for this lead

    const step = steps[nextStep];

    // Delay anchor: the most recent successfully-sent email for this lead --
    // the last follow-up that went out, or the pitch if none have.
    const sentPriors = prior.filter((f) => f.sentAt);
    const anchor = sentPriors.length ? sentPriors[sentPriors.length - 1] : pitch;
    if (!ignoreDelay) {
      const anchorAt = anchor.sentAt ? new Date(anchor.sentAt).getTime() : 0;
      if (!anchorAt || now < anchorAt + step.delayMs) continue; // not due yet
    }

    // 1) CLAIM the step before sending, exactly as a pitch is claimed. The
    //    unique (campaignId, leadEmail, followupStep) index makes this atomic:
    //    a racing sender loses with E11000 and skips, instead of the duplicate
    //    email already being in the lead's inbox by the time we detect it.
    let claim;
    try {
      claim = await EmailMessage.create({
        campaignId: campaign._id,
        userId: campaign.userId,
        leadEmail: pitch.leadEmail,
        fields: fieldsToObject(pitch.fields),
        stage: "followup",
        followupStep: nextStep,
        status: "queued",
        // Follow-ups MUST go from the mailbox that sent the pitch, or they will
        // not thread.
        sendingAccountId: pitch.sendingAccountId || fallbackAccount,
      });
    } catch (e) {
      if (e && e.code === 11000) continue; // someone else owns this step
      throw e;
    }

    // Keep the in-memory view honest so a duplicate pitch row for the same lead
    // computes the correct nextStep on its visit.
    prior.push(claim);

    // 2) RESERVE.
    const allowed = await sendQuota.reserve(campaign.userId, {
      campaignId: campaign._id,
      stage: "followup",
    });
    if (!allowed) {
      await EmailMessage.deleteOne({ _id: claim._id }).catch(() => {});
      prior.pop();
      break;
    }

    // 3) ENQUEUE.
    //
    // Rolling the claim back on a queue failure is load-bearing here in a way
    // it is not for pitches: nextStep is derived from prior.length, which counts
    // every row. Leaving a dead row behind would not merely lose this step, it
    // would SKIP it -- the sequence would march on to step N+1 and the lead
    // would never receive step N at all.
    const queued = await enqueueEmail(claim._id);
    if (!queued) {
      await EmailMessage.deleteOne({ _id: claim._id }).catch(() => {});
      await sendQuota.refund(campaign.userId, { campaignId: campaign._id }).catch(() => {});
      prior.pop();
      break;
    }

    succeeded += 1;
  }

  return succeeded;
};

module.exports = {
  sendPitchBatch,
  sendOnePitch,
  sendFollowupBatch,
  resolveFollowupSteps,
  senderAccounts,
  pickTemplate,
  fieldsToObject,
  makeLeadSource,
};
