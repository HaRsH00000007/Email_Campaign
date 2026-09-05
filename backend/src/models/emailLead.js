// One document per lead.
//
// Leads are deliberately NOT embedded in the list. MongoDB caps a document at
// 16MB, and in the reference implementation a 244k-row upload built ~26MB of
// BSON and failed outright — capping any list at roughly 145k leads. One
// document per lead removes the ceiling entirely.
//
// NOTE: no per-lead `status`. See emailLeadList.js for why.

const mongoose = require("mongoose");

const emailLeadSchema = new mongoose.Schema(
  {
    listId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailLeadList",
      required: true,
    },

    // Position within the list, 0-based and DENSE.
    //
    // Load-bearing: campaign.progress.nextLeadIndex is an integer cursor into
    // this ordering. Keeping an explicit idx is what lets a campaign resume
    // mid-list and mail exactly the person it would have.
    idx: { type: Number, required: true },

    email: { type: String, required: true, lowercase: true, trim: true },

    // Arbitrary uploaded columns: { firstName: "Jane", company: "Acme", ... },
    // usable as {{variable}} in templates. A Map so any header works.
    fields: { type: Map, of: String, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The send path's hot read: "give me lead N of list L". Unique so a retried
// import batch cannot duplicate a position.
emailLeadSchema.index({ listId: 1, idx: 1 }, { unique: true });

// Lookups by address within a list (dedupe checks, membership).
emailLeadSchema.index({ listId: 1, email: 1 });

module.exports = mongoose.model("EmailLead", emailLeadSchema);
