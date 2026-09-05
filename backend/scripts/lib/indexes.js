// Index building and verification, shared by the boot check and the CLI script.
//
// WHY THIS IS NOT LEFT TO autoIndex
//
// Mongoose's autoIndex builds indexes on connect and SWALLOWS the errors. That
// matters most for the unique partial indexes on the message collection: a
// unique index cannot be built over a collection that already contains
// violating rows, so the database rejects the build, autoIndex eats the error,
// and the "at most one pitch per recipient" guarantee silently does not exist.
// You find out when a lead gets emailed twice.
//
// So: build explicitly, report every failure, and let the server refuse to send
// when a critical index is absent.

const mongoose = require("mongoose");
const models = require("../../src/models");
const EmailMessage = require("../../src/models/emailMessage");

// Build every declared index. Returns { built, failed: [{model, error}] }.
const buildAllIndexes = async () => {
  const failed = [];
  let built = 0;

  for (const [name, Model] of Object.entries(models)) {
    try {
      await Model.createIndexes();
      built += 1;
    } catch (err) {
      failed.push({ model: name, error: err.message });
    }
  }

  return { built, failed };
};

// Are the two unique partial indexes that carry the duplicate-send guarantee
// actually present on the live collection?
const verifyCriticalIndexes = async () => {
  const required = EmailMessage.REQUIRED_UNIQUE_INDEXES || [];
  const missing = [];

  try {
    const collection = mongoose.connection.db.collection(EmailMessage.collection.name);

    // Ensure they exist before checking, so a fresh database is not reported as
    // broken on first boot.
    await EmailMessage.createIndexes().catch(() => {});

    const existing = await collection.indexes();
    const names = new Set(existing.map((i) => i.name));

    for (const r of required) {
      if (!names.has(r)) missing.push(r);
    }
  } catch (err) {
    return { ok: false, missing: required, error: err.message };
  }

  return { ok: missing.length === 0, missing };
};

// Find rows that violate the unique constraints. Used by both the dedupe script
// and its dry-run reporting.
const findDuplicates = async () => {
  const dupPitches = await EmailMessage.aggregate([
    { $match: { stage: "pitch" } },
    {
      $group: {
        _id: { campaignId: "$campaignId", leadEmail: "$leadEmail" },
        ids: { $push: "$_id" },
        statuses: { $push: "$status" },
        n: { $sum: 1 },
      },
    },
    { $match: { n: { $gt: 1 } } },
  ]);

  const dupFollowups = await EmailMessage.aggregate([
    { $match: { stage: "followup" } },
    {
      $group: {
        _id: {
          campaignId: "$campaignId",
          leadEmail: "$leadEmail",
          followupStep: "$followupStep",
        },
        ids: { $push: "$_id" },
        statuses: { $push: "$status" },
        n: { $sum: 1 },
      },
    },
    { $match: { n: { $gt: 1 } } },
  ]);

  return { dupPitches, dupFollowups };
};

// Which duplicate row to KEEP: the one reflecting the lead's true best outcome.
// A real reply beats a bounce beats a plain delivery, which all beat a stale
// queued or failed row -- deleting the replied row and keeping a queued one
// would lose the single most valuable fact in the system.
const RANK = { replied: 6, bounced: 5, soft_bounced: 4, auto_reply: 4, sent: 3, failed: 2, queued: 1 };

const chooseKeeper = (ids, statuses) => {
  let bestIdx = 0;
  for (let i = 1; i < ids.length; i++) {
    if ((RANK[statuses[i]] || 0) > (RANK[statuses[bestIdx]] || 0)) bestIdx = i;
  }
  return { keep: ids[bestIdx], drop: ids.filter((_, i) => i !== bestIdx) };
};

module.exports = { buildAllIndexes, verifyCriticalIndexes, findDuplicates, chooseKeeper };
