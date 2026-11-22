// Spread-mode pacing math -- the single source of truth for "how do we split N
// leads across a duration and interval". The frontend mirrors this exact
// arithmetic in its live schedule preview, so the two must stay in step; that
// is why it lives in one pure, dependency-free module rather than being
// open-coded in the scheduler.
//
// Model: the list is sent over `durationDays`, in batches released every
// `intervalHours`. Batches/day = floor(24 / intervalHours). Each released batch
// then drains one email at a time with a random minDelaySec-maxDelaySec gap,
// rotating across the selected mailboxes.
//
// DEFAULTS deliver the house cadence: one batch (intervalHours 24, durationDays
// 1) that stages the whole list immediately and drains at a steady 60s gap.
// That is ~60 emails/hour per mailbox, matching the per-mailbox spacing floor
// enforced in services/rateLimit/mailboxLimiter.js. Nothing here CAPS a
// campaign -- the duration is a pacing target, not a stop; leftover leads keep
// sending past it.
//
// WHO ENFORCES WHAT. These numbers pace a CAMPAIGN and are advisory: the
// scheduler honours them, but a retry or a second campaign on the same mailbox
// does not. The hard per-mailbox floor lives in the limiter and is enforced
// atomically in Redis. If the two disagree, the limiter wins -- so a gap set
// below the mailbox spacing does not speed anything up, it just makes jobs
// queue and wait.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// Default inter-send gap. Both ends are 60s, so the out-of-the-box cadence is
// exactly one email per minute rather than a random walk around it.
const DEFAULT_MIN_DELAY_SEC = 60;
const DEFAULT_MAX_DELAY_SEC = 60;
// One batch a day = the whole list staged at once, then drained at the gap.
const DEFAULT_DURATION_DAYS = 1;
const DEFAULT_INTERVAL_HOURS = 24;

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

// Normalize whatever is stored or submitted into safe pacing values.
const normalizePacing = (pacing = {}) => {
  const durationDays = clampInt(pacing.durationDays, 1, 60, DEFAULT_DURATION_DAYS);
  const intervalHours = clampInt(pacing.intervalHours, 1, 24, DEFAULT_INTERVAL_HOURS);
  const minDelaySec = clampInt(pacing.minDelaySec, 1, 300, DEFAULT_MIN_DELAY_SEC);
  let maxDelaySec = clampInt(pacing.maxDelaySec, 1, 600, DEFAULT_MAX_DELAY_SEC);
  if (maxDelaySec < minDelaySec) maxDelaySec = minDelaySec; // keep the range valid
  return { durationDays, intervalHours, minDelaySec, maxDelaySec };
};

// Derived schedule for a campaign, given the lead count and how many mailboxes
// are sending. Pure -- safe to call anywhere, including from a request handler.
//
// `mailboxSpacingMs` is the per-mailbox floor the limiter will enforce. Pass it
// so the projection tells the truth about what will actually happen; omit it
// and the numbers describe campaign pacing alone.
const computeSchedule = (totalLeads, pacing, mailboxCount = 1, opts = {}) => {
  const { durationDays, intervalHours, minDelaySec, maxDelaySec } = normalizePacing(pacing);
  const leads = Math.max(0, Math.floor(Number(totalLeads) || 0));
  const boxes = Math.max(1, Math.floor(Number(mailboxCount) || 1));
  const mailboxSpacingMs = Math.max(0, Math.floor(Number(opts.mailboxSpacingMs) || 0));

  const batchesPerDay = Math.max(1, Math.floor(24 / intervalHours));
  const totalBatches = batchesPerDay * durationDays;
  const leadsPerBatch = totalBatches > 0 ? Math.ceil(leads / totalBatches) : leads;

  const perDay = leadsPerBatch * batchesPerDay; // approx leads / durationDays
  const perDayPerMailbox = perDay / boxes;

  // How long one batch takes to drain at the average inter-send gap. If this
  // exceeds the interval, batches overlap and the campaign runs behind its
  // stated duration -- worth surfacing in the UI rather than discovering later.
  const avgGapSec = (minDelaySec + maxDelaySec) / 2;
  const avgGapMs = avgGapSec * 1000;
  const intervalMs = intervalHours * HOUR_MS;
  const batchDrainSec = Math.max(0, leadsPerBatch - 1) * avgGapSec;
  const batchOverruns = batchDrainSec * 1000 > intervalMs;

  // -- What will ACTUALLY happen -------------------------------------------
  //
  // Three separate things can be the binding constraint, and the slowest wins.
  // Reporting only the first (as "per day" alone does) is how a schedule that
  // claims 1440/day quietly delivers 24.
  //
  //   1. the inter-send gap        -> 3600 / avgGapSec per hour
  //   2. the release schedule      -> leadsPerBatch / intervalHours per hour
  //   3. the mailbox spacing floor -> boxes * 3600000 / mailboxSpacingMs
  const batchesNeeded = leadsPerBatch > 0 ? Math.ceil(leads / leadsPerBatch) : 0;

  const gapCeilingPerHour = avgGapSec > 0 ? 3600 / avgGapSec : Infinity;

  // leadsPerBatch/intervalHours is the SUSTAINED release rate -- meaningful only
  // once a second batch has to be waited for. When the whole list fits in the
  // first batch the interval never comes around again, so it throttles nothing;
  // treating it as a ceiling there understates the default schedule by 24x
  // (it would report a 45-lead list as 1.9/hour instead of 60).
  const releaseCeilingPerHour =
    batchesNeeded > 1 ? leadsPerBatch / intervalHours : Infinity;

  const mailboxCeilingPerHour =
    mailboxSpacingMs > 0 ? (boxes * HOUR_MS) / mailboxSpacingMs : Infinity;

  const effectivePerHour = Math.min(
    gapCeilingPerHour,
    releaseCeilingPerHour,
    mailboxCeilingPerHour
  );
  const effectivePerDay = effectivePerHour * 24;

  // Which of the three is actually holding the campaign back. The UI names it,
  // because "it is slower than you think" is useless without "because of this".
  let limitedBy = "gap";
  if (releaseCeilingPerHour <= gapCeilingPerHour && releaseCeilingPerHour <= mailboxCeilingPerHour) {
    limitedBy = "batch_interval";
  } else if (mailboxCeilingPerHour < gapCeilingPerHour) {
    limitedBy = "mailbox_spacing";
  }

  // A batch so small it drains in a fraction of its interval leaves the mailbox
  // idle for the rest of the window. Legitimate when you genuinely want the list
  // stretched over weeks -- misleading when you did not realise you asked for it.
  const batchStarves =
    leads > 0 && leadsPerBatch > 0 && !batchOverruns && releaseCeilingPerHour < gapCeilingPerHour / 2;

  // Wall-clock to work through the whole list. Batches release on the interval
  // regardless of whether the previous one finished, so the run is bounded
  // below by the gap alone -- hence the max().
  const leadsInLastBatch = leadsPerBatch > 0 ? leads - (batchesNeeded - 1) * leadsPerBatch : 0;
  const scheduleBoundMs =
    batchesNeeded > 0
      ? (batchesNeeded - 1) * intervalMs + Math.max(0, leadsInLastBatch - 1) * avgGapMs
      : 0;
  const gapBoundMs = Math.max(0, leads - 1) * avgGapMs;
  const spacingBoundMs =
    mailboxSpacingMs > 0 ? (Math.max(0, leads - 1) * mailboxSpacingMs) / boxes : 0;
  const estimatedRunMs = Math.max(scheduleBoundMs, gapBoundMs, spacingBoundMs);

  return {
    durationDays,
    intervalHours,
    minDelaySec,
    maxDelaySec,
    batchesPerDay,
    totalBatches,
    leadsPerBatch,
    perDay,
    perBatchPerMailbox: leadsPerBatch / boxes,
    perDayPerMailbox,
    mailboxCount: boxes,
    totalLeads: leads,
    batchDrainSec,
    batchOverruns,
    batchStarves,
    // Truthful projections -- what the campaign will really do.
    effectivePerHour,
    effectivePerDay,
    effectivePerHourPerMailbox: effectivePerHour / boxes,
    limitedBy,
    estimatedRunMs,
    mailboxSpacingMs,
  };
};

// A random inter-send gap in ms, honouring the configured range.
const jitterMs = (pacing) => {
  const { minDelaySec, maxDelaySec } = normalizePacing(pacing);
  const sec = minDelaySec + Math.floor(Math.random() * (maxDelaySec - minDelaySec + 1));
  return sec * 1000;
};

module.exports = {
  normalizePacing,
  computeSchedule,
  jitterMs,
  DAY_MS,
  HOUR_MS,
  DEFAULT_MIN_DELAY_SEC,
  DEFAULT_MAX_DELAY_SEC,
  DEFAULT_DURATION_DAYS,
  DEFAULT_INTERVAL_HOURS,
};
