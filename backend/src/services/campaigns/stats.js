// Recompute a campaign's denormalized counters from its message rows.
//
// Keeping these on the campaign document is much cheaper than aggregating on
// every list render. The scheduler and the manual sync/follow-up endpoints call
// this whenever they change message state.

const mongoose = require("mongoose");
const { EmailCampaign, EmailMessage } = require("../../models");
const {
  isDelivered,
  HARD_BOUNCE_STATES,
  OTHER_STATES,
} = require("../replies/statusSets");

const recomputeCampaignStats = async (campaignId) => {
  // Count rows grouped by (stage, status) INSIDE Mongo rather than streaming
  // every message into Node. This runs once per active campaign on every tick,
  // and a large campaign has millions of rows -- hydrating (or even just
  // transferring) all of them each tick is the single heaviest recurring read
  // such a system can have. The grouped result is at most a few dozen buckets,
  // and the $match rides the campaignId index.
  const cid = mongoose.Types.ObjectId.isValid(campaignId)
    ? new mongoose.Types.ObjectId(String(campaignId))
    : campaignId;

  const groups = await EmailMessage.aggregate([
    { $match: { campaignId: cid } },
    { $group: { _id: { stage: "$stage", status: "$status" }, n: { $sum: 1 } } },
  ]);

  // `sent` means DELIVERED (reached a real mailbox) -- the reply-rate
  // denominator -- so a bounce does not count as a successful send.
  const stats = {
    total: 0,
    sent: 0,
    replied: 0,
    followupsSent: 0,
    failed: 0,
    bounced: 0,
    other: 0,
    queued: 0,
  };

  for (const g of groups) {
    const { stage, status } = g._id;
    const n = g.n;

    if (stage === "pitch") {
      stats.total += n;
      if (isDelivered(status)) stats.sent += n;
      if (status === "replied") stats.replied += n;
      if (status === "failed") stats.failed += n;
      if (status === "queued") stats.queued += n;
      if (HARD_BOUNCE_STATES.includes(status)) stats.bounced += n;
      if (OTHER_STATES.includes(status)) stats.other += n;
    } else if (stage === "followup") {
      if (isDelivered(status)) stats.followupsSent += n;
      if (status === "queued") stats.queued += n;
    }
  }

  await EmailCampaign.updateOne({ _id: campaignId }, { $set: { stats } });
  return stats;
};

// Reply rate over DELIVERED pitches, which is the only denominator that means
// anything. Exposed so the API and the UI cannot disagree about the arithmetic.
const replyRate = (stats) => {
  const delivered = stats?.sent || 0;
  if (!delivered) return 0;
  return Math.round(((stats.replied || 0) / delivered) * 1000) / 10;
};

module.exports = { recomputeCampaignStats, replyRate };
