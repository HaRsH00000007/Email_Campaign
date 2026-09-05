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

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

// Normalize whatever is stored or submitted into safe pacing values.
const normalizePacing = (pacing = {}) => {
  const durationDays = clampInt(pacing.durationDays, 1, 60, 1);
  const intervalHours = clampInt(pacing.intervalHours, 1, 24, 1);
  const minDelaySec = clampInt(pacing.minDelaySec, 1, 300, 30);
  let maxDelaySec = clampInt(pacing.maxDelaySec, 1, 600, 120);
  if (maxDelaySec < minDelaySec) maxDelaySec = minDelaySec; // keep the range valid
  return { durationDays, intervalHours, minDelaySec, maxDelaySec };
};

// Derived schedule for a campaign, given the lead count and how many mailboxes
// are sending. Pure -- safe to call anywhere, including from a request handler.
const computeSchedule = (totalLeads, pacing, mailboxCount = 1) => {
  const { durationDays, intervalHours, minDelaySec, maxDelaySec } = normalizePacing(pacing);
  const leads = Math.max(0, Math.floor(Number(totalLeads) || 0));
  const boxes = Math.max(1, Math.floor(Number(mailboxCount) || 1));

  const batchesPerDay = Math.max(1, Math.floor(24 / intervalHours));
  const totalBatches = batchesPerDay * durationDays;
  const leadsPerBatch = totalBatches > 0 ? Math.ceil(leads / totalBatches) : leads;

  const perDay = leadsPerBatch * batchesPerDay; // approx leads / durationDays
  const perDayPerMailbox = perDay / boxes;

  // How long one batch takes to drain at the average inter-send gap. If this
  // exceeds the interval, batches overlap and the campaign runs behind its
  // stated duration -- worth surfacing in the UI rather than discovering later.
  const avgGapSec = (minDelaySec + maxDelaySec) / 2;
  const batchDrainSec = Math.max(0, leadsPerBatch - 1) * avgGapSec;
  const batchOverruns = batchDrainSec > intervalHours * 3600;

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
  };
};

// A random inter-send gap in ms, honouring the configured range.
const jitterMs = (pacing) => {
  const { minDelaySec, maxDelaySec } = normalizePacing(pacing);
  const sec = minDelaySec + Math.floor(Math.random() * (maxDelaySec - minDelaySec + 1));
  return sec * 1000;
};

module.exports = { normalizePacing, computeSchedule, jitterMs, DAY_MS, HOUR_MS };
