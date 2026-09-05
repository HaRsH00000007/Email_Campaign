// One row per email. The unit of claiming, sending, and reply tracking.
//
// The row is created BEFORE the send, as a claim (status "queued"). That is the
// whole idempotency mechanism: the unique partial indexes at the bottom of this
// file mean the DATABASE refuses a second pitch to the same person, so the
// sender never has to ask "did I already send this?" -- a question two racing
// workers can both answer "no".

const mongoose = require("mongoose");
const { ALL_STATES } = require("../services/replies/statusSets");

const emailMessageSchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailCampaign",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    leadEmail: { type: String, required: true, lowercase: true, trim: true },

    // Snapshot of the lead's columns at send time, so a later follow-up renders
    // identically even if the source list changed underneath.
    fields: { type: Map, of: String, default: {} },

    stage: { type: String, enum: ["pitch", "followup"], default: "pitch" },

    // For follow-up rows, which step of the sequence this is (0-based).
    // null for pitch rows.
    followupStep: { type: Number, default: null },

    // Which pitch variant was used (index into campaign.pitches). Lets replies
    // be attributed back to a variant.
    templateIndex: { type: Number, default: null },

    // Which mailbox sent this. With rotation across accounts, a follow-up must
    // go from the SAME mailbox as the pitch to stay in-thread.
    sendingAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailAccount",
      default: null,
    },

    // Gmail identifiers from messages/send. threadId is what reply tracking reads.
    gmailMessageId: { type: String, default: "" },
    threadId: { type: String, default: "" },

    // What we ACTUALLY sent. The campaign template cannot reconstruct it --
    // variants are random, {{fields}} are per-lead, and with uniqueEmails the
    // copy is rewritten per person. Recorded so the conversation view shows the
    // real email, and so it survives later edits to the campaign.
    subject: { type: String, default: "" },
    bodyHtml: { type: String, default: "" },

    // Outcome. "sent" = delivered, awaiting a reply. Terminal outcomes are set
    // by reply sync from the Gmail thread:
    //   replied      - a genuine human reply
    //   bounced      - HARD bounce: wrong / invalid address
    //   soft_bounced - other delivery failure (full, blocked, temporary)
    //   auto_reply   - an autoresponder: delivered, but NOT a reply
    //   failed       - send-time failure
    // See services/replies/statusSets.js for how these roll up.
    status: { type: String, enum: ALL_STATES, default: "queued" },

    // Set when an inbound message resolves this row. The snippet is Gmail's own
    // preview -- enough to show a summary without a second API call, and the
    // only record kept if read access is later revoked. For a bounce these hold
    // the daemon's From and preview so the UI can explain WHY.
    replyFrom: { type: String, default: "" },
    replySnippet: { type: String, default: "" },

    sentAt: { type: Date, default: null },
    repliedAt: { type: Date, default: null },
    bouncedAt: { type: Date, default: null },
    bounceReason: { type: String, default: "" },
    lastCheckedAt: { type: Date, default: null },
    error: { type: String, default: "" },
  },
  { timestamps: true }
);

// -- Read-path indexes -------------------------------------------------------
emailMessageSchema.index({ campaignId: 1, leadEmail: 1, stage: 1 });

// Backs the runner's "sent pitches, oldest first" follow-up scan and the
// per-campaign stats rollup.
emailMessageSchema.index({ campaignId: 1, stage: 1, status: 1, sentAt: 1 });

// Backs reply sync's pending-poll query, which filters on {campaignId, status}
// and sorts by lastCheckedAt.
emailMessageSchema.index({ campaignId: 1, status: 1, lastCheckedAt: 1 });

// Backs the metrics aggregations.
emailMessageSchema.index({ userId: 1, status: 1, sentAt: -1 });

// Backs incremental history sync, which resolves inbound Gmail threads back to
// the rows waiting on them:
//   find({ threadId: { $in: [...] }, status: { $in: ["sent","auto_reply"] } })
// Without it, every reply-detection pass collection-scans this collection.
emailMessageSchema.index({ threadId: 1, status: 1 });

// Backs the reaper's orphaned-claim sweep.
emailMessageSchema.index({ status: 1, createdAt: 1 });

// -- THE DUPLICATE-SEND GUARANTEE --------------------------------------------
// At most ONE pitch per recipient per campaign. The sender claims a lead by
// inserting its pitch row before sending; a second sender -- a racing worker, a
// restarted process, or a duplicate address in the uploaded list -- fails the
// insert with E11000 and skips. Partial, so it binds only pitch rows;
// follow-ups legitimately have several rows per lead, one per step.
//
// CAVEAT: a unique index CANNOT be built over a collection that already
// contains violating rows. Mongo rejects the build and the autoIndex path
// swallows the error, so this guarantee can silently not exist. That is why
// this project does NOT rely on autoIndex -- scripts/ensureIndexes.js builds
// every index explicitly and reports failures, and server boot verifies both
// unique indexes are present before accepting traffic.
emailMessageSchema.index(
  { campaignId: 1, leadEmail: 1 },
  {
    unique: true,
    partialFilterExpression: { stage: "pitch" },
    name: "uniq_pitch_per_lead",
  }
);

// The same guarantee one level down: at most ONE row per (lead, follow-up step).
// The runner claims a step by inserting this row before sending, so a scheduler
// tick and a manual "follow up now" click cannot both deliver step N.
emailMessageSchema.index(
  { campaignId: 1, leadEmail: 1, followupStep: 1 },
  {
    unique: true,
    partialFilterExpression: { stage: "followup" },
    name: "uniq_followup_step_per_lead",
  }
);

// The names the boot check and the repair script look for.
const REQUIRED_UNIQUE_INDEXES = ["uniq_pitch_per_lead", "uniq_followup_step_per_lead"];

const EmailMessage = mongoose.model("EmailMessage", emailMessageSchema);
EmailMessage.REQUIRED_UNIQUE_INDEXES = REQUIRED_UNIQUE_INDEXES;

module.exports = EmailMessage;
module.exports.REQUIRED_UNIQUE_INDEXES = REQUIRED_UNIQUE_INDEXES;
