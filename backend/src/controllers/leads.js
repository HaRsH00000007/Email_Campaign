// Lead lists: CSV/XLSX upload, background import, listing, deletion.

const XLSX = require("xlsx");
const { EmailLeadList, EmailLead, EmailCampaign } = require("../models");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Leads are inserted in batches rather than as one array. A large list is far
// past MongoDB's 16MB per-document limit, which is why the single-document form
// fails outright on big uploads.
const INSERT_BATCH = 2000;

// Batches run several at a time: the insert is latency-bound against the
// database, not CPU-bound, so awaiting each round trip in turn wastes most of
// the wall clock. Past ~8 the connection pool saturates and it gets slower again.
const INSERT_CONCURRENCY = 8;

// An import with no heartbeat for this long is treated as dead -- the process
// restarted or crashed mid-insert and nothing will ever finish it.
const IMPORT_STALL_MS = 60_000;

// Uploaded headers become Mongoose Map keys, and a Map key may not contain "."
// or start with "$" -- Mongoose rejects the WHOLE document with a cast error if
// it does. So a single spreadsheet column named "Phone No." would make every
// lead in the file invalid.
//
// In the reference implementation that failure was silent AND total: an
// unordered insertMany skips invalid documents and still resolves, the importer
// counted the rows it HANDED to Mongo rather than the ones Mongo took, and the
// list was then stamped done with a full count. The campaign pointed at it
// walked every cursor position, found no lead document at any of them, and
// marked itself completed without sending one email.
//
// Normalizing here means a header can no longer be un-storable. `columns` is
// normalized with the same function because that array drives the template
// editor's variable picker -- it has to offer the name that was actually
// stored, or the {{token}} renders empty.
const safeFieldKey = (h) =>
  String(h)
    .replace(/\./g, " ")
    .replace(/^\$+/, "")
    .replace(/\s+/g, " ")
    .trim();

// Find the email value regardless of header casing ("Email", "EMAIL", "e-mail").
const pickEmail = (row) => {
  for (const k of Object.keys(row)) {
    const key = String(k).trim().toLowerCase().replace(/[-_\s]/g, "");
    if (key === "email" || key === "emailaddress") {
      return String(row[k] ?? "").trim().toLowerCase();
    }
  }
  return "";
};

// Fill the EmailLead collection, reporting progress as it goes. Runs AFTER the
// HTTP response has been sent.
//
// On ANY failure the whole list is torn down rather than left half-imported: a
// partial list that looked importable would mail some of the file and silently
// drop the rest, which is worse than a visible failure.
const runImport = async (listId, leads, skipped) => {
  const total = leads.length;
  const chunks = [];
  for (let i = 0; i < total; i += INSERT_BATCH) chunks.push(leads.slice(i, i + INSERT_BATCH));

  try {
    let inserted = 0;

    for (let i = 0; i < chunks.length; i += INSERT_CONCURRENCY) {
      const round = chunks.slice(i, i + INSERT_CONCURRENCY);

      const results = await Promise.all(
        round.map((c) =>
          EmailLead.insertMany(
            c.map((l) => ({ ...l, listId })),
            // ordered:false keeps one bad row from aborting the rest of a batch,
            // but on its own it also SWALLOWS validation failures. Opting into
            // throwOnValidationError is what turns "silently imported nothing"
            // into a real error that reaches the catch below.
            { ordered: false, throwOnValidationError: true }
          )
        )
      );

      // Count what the database ACTUALLY accepted, never what we handed it.
      const wrote = results.reduce((n, r) => n + (Array.isArray(r) ? r.length : 0), 0);
      const meant = round.reduce((n, c) => n + c.length, 0);
      if (wrote !== meant) {
        throw new Error(`insert accepted only ${wrote} of ${meant} leads in this round`);
      }
      inserted += wrote;

      await EmailLeadList.updateOne(
        { _id: listId },
        { $set: { "importStatus.inserted": inserted, "importStatus.updatedAt": new Date() } }
      );
    }

    // leadCount is set only NOW, at the end: it is what makes the list
    // selectable by a campaign, so it must never describe a partial import.
    await EmailLeadList.updateOne(
      { _id: listId },
      {
        $set: {
          leadCount: total,
          importStatus: {
            state: "done",
            inserted: total,
            total,
            skipped,
            error: "",
            updatedAt: new Date(),
          },
        },
      }
    );

    console.log(`[leads] imported ${total} lead(s) into list ${listId}`);
  } catch (err) {
    await EmailLead.deleteMany({ listId }).catch(() => {});
    await EmailLeadList.updateOne(
      { _id: listId },
      {
        $set: {
          leadCount: 0,
          importStatus: {
            state: "failed",
            inserted: 0,
            total,
            skipped,
            error: String(err?.message || "Import failed").slice(0, 300),
            updatedAt: new Date(),
          },
        },
      }
    ).catch(() => {});
    console.error(`[leads] import failed for list ${listId}:`, err.message);
  }
};

// POST /leads/upload  (multipart: file=<csv|xlsx|xls>, name)
//
// Responds 202 as soon as the file is parsed and validated, then imports in the
// background. A large file takes long enough that holding the request open
// risks a gateway timeout -- which reports failure to the user while the import
// runs on to completion anyway. The client polls import-status instead.
const upload = async (req, res) => {
  const userId = req.user.id;
  const name = String(req.body?.name || "").trim();

  if (!name) return res.status(400).json({ message: "List name is required" });
  if (!req.file) return res.status(400).json({ message: "A CSV or Excel file is required" });

  let rows;
  let headers;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false });
    headers = (aoa[0] || []).map((h) => String(h).trim()).filter(Boolean);
    rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  } catch {
    return res.status(400).json({ message: "Couldn't read that file -- is it a valid CSV or Excel file?" });
  }

  if (!headers.length) return res.status(400).json({ message: "No columns detected in the file" });
  if (!rows.length) return res.status(400).json({ message: "The file has no rows" });

  const hasEmailCol = headers.some((c) => {
    const k = c.toLowerCase().replace(/[-_\s]/g, "");
    return k === "email" || k === "emailaddress";
  });
  if (!hasEmailCol) {
    return res.status(400).json({ message: 'The file must have an "email" column' });
  }

  const existing = await EmailLeadList.findOne({ userId, name });
  if (existing) {
    // A list whose import died is not a real list -- it holds no leads and
    // cannot be used. Blocking the name would leave the user unable to retry
    // the same upload, so clear it and let this one take the name.
    if (existing.importStatus?.state === "failed") {
      await EmailLead.deleteMany({ listId: existing._id }).catch(() => {});
      await EmailLeadList.deleteOne({ _id: existing._id });
    } else {
      return res.status(400).json({ message: "A list with this name already exists" });
    }
  }

  const leads = [];
  const seen = new Set();
  let skipped = 0;

  for (const row of rows) {
    const email = pickEmail(row);
    if (!email || !EMAIL_RE.test(email)) {
      skipped += 1;
      continue;
    }
    if (seen.has(email)) {
      skipped += 1; // de-dupe within the upload
      continue;
    }
    seen.add(email);

    // Store every column (including email) so templates can use any of them.
    // The VALUE is verbatim; only the KEY is normalized.
    const fields = {};
    for (const col of headers) {
      const key = safeFieldKey(col);
      if (!key) continue; // header was punctuation only -- nothing to key on
      if (row[col] != null && row[col] !== "") fields[key] = String(row[col]);
    }

    // idx must be dense and stable: it is the cursor a campaign walks.
    leads.push({ email, fields, idx: leads.length });
  }

  if (!leads.length) {
    return res.status(400).json({ message: "No valid rows (every row was missing a usable email)" });
  }

  const list = await EmailLeadList.create({
    userId,
    name,
    columns: [...new Set(headers.map(safeFieldKey).filter(Boolean))],
    leadCount: 0,
    importStatus: {
      state: "importing",
      inserted: 0,
      total: leads.length,
      skipped,
      updatedAt: new Date(),
    },
  });

  // Deliberately NOT awaited: the response goes out now and the insert
  // continues. Errors are recorded on importStatus (the client is polling it),
  // so this catch is only a last-resort guard against an unhandled rejection.
  runImport(list._id, leads, skipped).catch(() => {});

  return res.status(202).json({
    message: "Import started",
    data: {
      _id: list._id,
      name: list.name,
      columns: list.columns,
      leadCount: 0,
      total: leads.length,
      skipped,
      importState: "importing",
    },
  });
};

// GET /leads
const list = async (req, res) => {
  const lists = await EmailLeadList.find({ userId: req.user.id })
    .select("name columns leadCount importStatus createdAt")
    .sort({ createdAt: -1 })
    .lean();

  return res.json({
    ok: true,
    data: lists.map((l) => ({
      _id: l._id,
      name: l.name,
      columns: l.columns,
      leadCount: l.leadCount || 0,
      importState: l.importStatus?.state || "done",
      createdAt: l.createdAt,
    })),
  });
};

// GET /leads/:id/import-status
const importStatus = async (req, res) => {
  const l = await EmailLeadList.findOne({ _id: req.params.id, userId: req.user.id })
    .select("name columns leadCount importStatus")
    .lean();

  if (!l) return res.status(404).json({ message: "List not found" });

  const st = l.importStatus || {};
  let state = st.state || "done";
  const total = st.total || l.leadCount || 0;
  const inserted = state === "done" ? total : st.inserted || 0;

  // No heartbeat for a while means the process died mid-import. Report the
  // failure rather than leaving the client polling a bar that never moves.
  if (state === "importing" && Date.now() - new Date(st.updatedAt || 0).getTime() > IMPORT_STALL_MS) {
    state = "failed";
  }

  return res.json({
    ok: true,
    data: {
      _id: l._id,
      name: l.name,
      columns: l.columns,
      state,
      inserted,
      total,
      skipped: st.skipped || 0,
      percent: total ? Math.floor((inserted / total) * 100) : 0,
      leadCount: l.leadCount || 0,
      error: st.error || "",
    },
  });
};

// GET /leads/:id -> metadata + a small preview
const getOne = async (req, res) => {
  const l = await EmailLeadList.findOne({ _id: req.params.id, userId: req.user.id })
    .select("name columns leadCount importStatus")
    .lean();

  if (!l) return res.status(404).json({ message: "List not found" });

  const preview = await EmailLead.find({ listId: l._id })
    .select("email fields idx")
    .sort({ idx: 1 })
    .limit(10)
    .lean();

  return res.json({
    ok: true,
    data: {
      _id: l._id,
      name: l.name,
      columns: l.columns,
      leadCount: l.leadCount || 0,
      importState: l.importStatus?.state || "done",
      preview: preview.map((ld) => ({ email: ld.email, fields: ld.fields })),
    },
  });
};

// DELETE /leads/:id
const remove = async (req, res) => {
  const listId = req.params.id;

  // Refuse while a campaign still points at it: nextLeadIndex is a cursor INTO
  // this list, so deleting it underneath a running campaign leaves that cursor
  // meaningless.
  const inUse = await EmailCampaign.countDocuments({
    userId: req.user.id,
    leadListId: listId,
    status: { $in: ["active", "paused"] },
  });
  if (inUse > 0) {
    return res.status(409).json({
      message: `${inUse} campaign(s) still use this list. Complete or delete them first.`,
    });
  }

  const deleted = await EmailLeadList.findOneAndDelete({ _id: listId, userId: req.user.id });
  if (!deleted) return res.status(404).json({ message: "List not found" });

  // The leads are separate documents -- deleting the list alone orphans them.
  await EmailLead.deleteMany({ listId: deleted._id });

  return res.json({ ok: true });
};

module.exports = { upload, list, getOne, importStatus, remove };
