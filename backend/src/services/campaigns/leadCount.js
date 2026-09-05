// Reads EmailLeadList.leadCount, self-healing whenever it cannot be trusted.
//
// THE CONTRACT, and it is the whole reason this file is not a one-liner:
//
//   NEVER RETURN A ZERO THAT HAS NOT BEEN VERIFIED AGAINST THE LEAD DOCUMENTS.
//
// Zero is not just another number here -- it is the single answer that makes
// callers DESTROY work. A spread campaign that reads 0 releases no batches and
// discards any it had already staged, parking the campaign until its next
// interval (up to 24h on a one-batch-a-day config). In the reference
// implementation this was observed in production as a 244,507-lead campaign
// emitting one to three emails an hour, indefinitely, with the staged batch
// resetting to the same value every hour instead of draining. The stored count
// was correct the entire time -- the ZERO CAME FROM THE READ, not the data.
//
// "No leadCount field", "the list document did not come back", and "there are
// genuinely no leads" are three different situations, and only the last may
// report 0. So a 0 or a missing document is treated as UNKNOWN, and we go count
// the lead documents before reporting anything.
//
// Note that THROWING is safer than fabricating a 0: an exception aborts the
// tick without mutating batch state, and the next tick retries. So "unknown"
// must always resolve to a real count or an exception, never to 0.

const EmailLeadList = require("../../models/emailLeadList");
const EmailLead = require("../../models/emailLead");

const getLeadCount = async (leadListId) => {
  if (!leadListId) return 0;

  const doc = await EmailLeadList.findById(leadListId)
    .select("leadCount importStatus.state")
    .lean();

  if (!doc) {
    // The list document read came back empty. That may be a genuinely deleted
    // list, or a read that failed to see it -- the lead documents decide.
    const n = await EmailLead.countDocuments({ listId: leadListId });
    console.warn(`[leadCount] list ${leadListId} not found -- lead documents say ${n}`);
    return n;
  }

  // An import still running legitimately has no usable count yet, and its lead
  // documents are arriving as we look. Counting them here would return a
  // PARTIAL total and heal it onto the row -- which is exactly what makes a
  // list selectable by a campaign, so the campaign would mail part of the file
  // and silently drop the rest. A half-imported list must keep reading as 0
  // until the importer says done.
  if (doc.importStatus?.state === "importing") return 0;

  // A positive stored count is authoritative. This is the hot path -- one
  // indexed point read per tick.
  if (typeof doc.leadCount === "number" && doc.leadCount > 0) return doc.leadCount;

  // Zero or missing on a list that is NOT importing: verify against the lead
  // documents and heal the row. Cheap -- it rides the {listId, idx} index, and
  // a genuinely empty list counts zero rows.
  const n = await EmailLead.countDocuments({ listId: doc._id });
  if (n !== (doc.leadCount || 0)) {
    console.warn(
      `[leadCount] list ${leadListId} stored leadCount=${doc.leadCount} but has ${n} lead documents -- healing`
    );
    await EmailLeadList.updateOne({ _id: doc._id }, { $set: { leadCount: n } }).catch(() => {});
  }
  return n;
};

module.exports = { getLeadCount };
