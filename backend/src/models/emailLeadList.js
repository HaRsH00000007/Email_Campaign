// A lead list: an address book that campaigns point at.
//
// A list is REUSABLE — two campaigns may target the same list — which is why
// "already emailed" is never stored here or on a lead. It belongs to the
// campaign/lead pair, and lives on EmailMessage.

const mongoose = require("mongoose");

const emailLeadListSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },

    // Header names in upload order. Drives the template editor's "insert
    // variable" picker, so it must hold the keys that were ACTUALLY stored on
    // the leads (post-normalization), or the {{token}} would render empty.
    columns: { type: [String], default: [] },

    // Denormalized count of EmailLead documents with this listId. Set once by
    // the importer; services/campaigns/leadCount.js reads it and self-heals.
    leadCount: { type: Number, default: 0 },

    // Progress of the background import.
    //
    // A large file takes tens of seconds to insert — too long to hold an HTTP
    // request open, since gateways cut off around 30-60s and would show the user
    // an error while the import quietly continued. So upload responds 202 and
    // the client polls this.
    //
    // leadCount stays 0 until state === "done". That is what stops a
    // half-imported list being selectable by a campaign and mailing part of a
    // file.
    importStatus: {
      state: {
        type: String,
        enum: ["importing", "done", "failed"],
        default: "done",
      },
      inserted: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      error: { type: String, default: "" },
      // Heartbeat. If the process dies mid-import the state would sit at
      // "importing" forever; a stale timestamp lets the status endpoint report
      // failure instead of spinning.
      updatedAt: { type: Date, default: Date.now },
    },
  },
  { timestamps: true }
);

emailLeadListSchema.index({ userId: 1, name: 1 }, { unique: true });
emailLeadListSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("EmailLeadList", emailLeadListSchema);
