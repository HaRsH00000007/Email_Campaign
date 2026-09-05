// An email campaign: sends a pitch to every lead in a list from one or more
// connected mailboxes, tracks replies, and walks non-repliers through a
// follow-up sequence that stops the moment they answer.
//
// This document is config + denormalized progress and stats. The scheduler
// (services/campaigns/scheduler.js) does the work; keeping counters here makes
// the dashboard list view a single query.
//
// ADAPTED: the reference implementation carried a parallel set of legacy
// single-value fields (`pitch`, `emailAccountId`, `followup.subject/html/
// templates`) alongside the array forms, kept in sync on every write, with the
// runner falling back between them. That existed to support campaigns created
// before the array forms did. A new project has no such history, so only the
// array forms remain — which removes an entire class of "which field is
// authoritative?" bug.

const mongoose = require("mongoose");

// One first-pitch variant. `html` may contain {{column}} tokens resolved
// per-lead at send time.
const templateSchema = new mongoose.Schema(
  {
    subject: { type: String, default: "" },
    html: { type: String, default: "" },
  },
  { _id: false }
);

// One step in the follow-up sequence: its message, plus how long to wait AFTER
// the previous email (the pitch for step 0, the prior follow-up otherwise).
const followupStepSchema = new mongoose.Schema(
  {
    delayDays: { type: Number, default: 3, min: 0, max: 60 },
    delayHours: { type: Number, default: 0, min: 0, max: 23 },
    subject: { type: String, default: "" },
    html: { type: String, default: "" },
  },
  { _id: false }
);

const emailCampaignSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },

    // Sending mailboxes. With two or more the sender rotates round-robin, so
    // the day's volume splits evenly — better deliverability, and each mailbox
    // stays under its own limit.
    emailAccountIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "EmailAccount" }],
      default: [],
    },

    leadListId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailLeadList",
      default: null,
    },

    // First-pitch variants. One is picked uniformly at random per lead, so the
    // list splits across variants for A/B testing. At least one is required to
    // launch.
    pitches: { type: [templateSchema], default: [] },

    // ── Per-recipient rewriting ──────────────────────────────────────────────
    // OFF: the template is sent as written — every recipient gets byte-identical
    // copy, which is exactly the fingerprint bulk filters look for.
    // ON: the template becomes a REFERENCE. Immediately before each send an LLM
    // rewrites it for that one recipient — same offer, same CTA, same links,
    // different wording. If the rewrite fails for any reason the original
    // rendered copy is sent, so this can never block a campaign.
    uniqueEmails: { type: Boolean, default: false },

    followup: {
      enabled: { type: Boolean, default: true },
      // Ordered sequence. The scheduler sends step 0, then step 1, ... to any
      // lead who still hasn't replied, stopping the moment they do.
      steps: { type: [followupStepSchema], default: [] },
    },

    // ── Pacing ───────────────────────────────────────────────────────────────
    //   "rate"   — send sendRatePerMin pitches/min up to dailyLimit.
    //   "spread" — distribute the whole list over durationDays, in batches
    //              released every intervalHours. Each batch drains one email at
    //              a time with a random minDelaySec-maxDelaySec gap between
    //              sends, rotating across mailboxes. Duration is a pacing
    //              TARGET, not a hard stop: leftover leads keep sending past it.
    pacing: {
      mode: { type: String, enum: ["rate", "spread"], default: "spread" },
      durationDays: { type: Number, default: 1, min: 1, max: 60 },
      intervalHours: { type: Number, default: 1, min: 1, max: 24 },
      minDelaySec: { type: Number, default: 30, min: 1, max: 300 },
      maxDelaySec: { type: Number, default: 120, min: 1, max: 600 },
    },

    // Used when pacing.mode === "rate".
    sendRatePerMin: { type: Number, default: 20, min: 1, max: 120 },
    dailyLimit: { type: Number, default: 500, min: 1 },

    progress: {
      nextLeadIndex: { type: Number, default: 0 },
      sentToday: { type: Number, default: 0 },
      dayKey: { type: String, default: "" }, // "YYYY-MM-DD", for the daily reset
      totalSent: { type: Number, default: 0 },
      lastTickAt: { type: Date, default: null },

      // Spread-mode scheduling state.
      nextBatchAt: { type: Date, default: null },   // when the next batch releases
      batchRemaining: { type: Number, default: 0 }, // leads left in released batches
      nextSendAt: { type: Date, default: null },    // earliest the next email may go
      acctCursor: { type: Number, default: 0 },     // round-robin pointer
      leadsPerBatch: { type: Number, default: 0 },  // cached, recomputed each tick
    },

    // Denormalized counters, rebuilt by services/campaigns/stats.js.
    // `sent` means DELIVERED (reached a real mailbox) — it is the reply-rate
    // denominator, so a bounce does not count. See services/replies/statusSets.js.
    stats: {
      total: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      replied: { type: Number, default: 0 },
      followupsSent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      bounced: { type: Number, default: 0 },
      other: { type: Number, default: 0 },
      queued: { type: Number, default: 0 },
    },

    status: {
      type: String,
      enum: ["draft", "active", "paused", "completed"],
      default: "draft",
      index: true,
    },

    // Why the campaign stopped, when it wasn't the operator's doing.
    stoppedReason: { type: String, default: "" },
  },
  { timestamps: true }
);

// The spread-mode send loop runs every few seconds against
// {status:"active", "pacing.mode":"spread"}. With only a single-field {status}
// index that resolves every active campaign and then filters in a FETCH stage,
// many times a minute, forever.
emailCampaignSchema.index({ status: 1, "pacing.mode": 1 });

// Dashboard list view: find({userId}).sort({createdAt:-1}). The compound turns
// a filter-then-sort-in-memory into a pure index scan.
emailCampaignSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("EmailCampaign", emailCampaignSchema);
