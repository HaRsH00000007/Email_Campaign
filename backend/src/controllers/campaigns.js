// Campaign CRUD, lifecycle, manual actions and the activity export.

const {
  EmailCampaign,
  EmailLeadList,
  EmailAccount,
  EmailMessage,
} = require("../models");
const { sendFollowupBatch, resolveFollowupSteps } = require("../services/campaigns/runner");
const { syncCampaignReplies } = require("../services/replies/replySync");
const { recomputeCampaignStats, replyRate } = require("../services/campaigns/stats");
const { computeSchedule } = require("../services/campaigns/pacing");
const { getLeadCount } = require("../services/campaigns/leadCount");
const { unresolvedTokens } = require("../services/personalization/templating");
const { STATUS_LABEL } = require("../services/replies/statusSets");
const { SCOPE_SEND } = require("../services/gmail/oauth");

const POPULATE = [
  { path: "emailAccountIds", select: "email connected grantedScopes" },
  // leadCount, NOT the leads: the dashboard only renders the count.
  { path: "leadListId", select: "name columns leadCount importStatus.state" },
];

// -- Input normalization -----------------------------------------------------

const cleanAccountIds = (arr) => {
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(arr) ? arr : []) {
    const s = String(id || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 25) break;
  }
  return out;
};

const clamp = (v, lo, hi, d) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

const cleanPacing = (p) => {
  if (!p || typeof p !== "object") return undefined;
  const minDelaySec = clamp(p.minDelaySec, 1, 300, 30);
  let maxDelaySec = clamp(p.maxDelaySec, 1, 600, 120);
  if (maxDelaySec < minDelaySec) maxDelaySec = minDelaySec;
  return {
    mode: p.mode === "rate" ? "rate" : "spread",
    durationDays: clamp(p.durationDays, 1, 60, 1),
    intervalHours: clamp(p.intervalHours, 1, 24, 1),
    minDelaySec,
    maxDelaySec,
  };
};

const cleanTemplates = (arr) =>
  (Array.isArray(arr) ? arr : [])
    .map((t) => ({ subject: String(t?.subject || ""), html: String(t?.html || "") }))
    .filter((t) => t.subject.trim() || t.html.trim())
    .slice(0, 10);

const cleanSteps = (arr) =>
  (Array.isArray(arr) ? arr : [])
    .map((s) => ({
      delayDays: clamp(s?.delayDays, 0, 60, 0),
      delayHours: clamp(s?.delayHours, 0, 23, 0),
      subject: String(s?.subject || ""),
      html: String(s?.html || ""),
    }))
    .filter((s) => s.subject.trim() || s.html.trim())
    .slice(0, 10);

// Shape a campaign for the client.
const shape = (c) => {
  const obj = c.toObject ? c.toObject() : c;

  if (obj.leadListId && typeof obj.leadListId === "object") {
    obj.leadList = {
      _id: obj.leadListId._id,
      name: obj.leadListId.name,
      columns: obj.leadListId.columns,
      leadCount: obj.leadListId.leadCount ?? 0,
    };
    obj.leadListId = obj.leadListId._id;
  }

  if (Array.isArray(obj.emailAccountIds) && obj.emailAccountIds[0]?.email) {
    obj.emailAccounts = obj.emailAccountIds.map((a) => ({
      _id: a._id,
      email: a.email,
      connected: a.connected,
      canSend: (a.grantedScopes || []).includes(SCOPE_SEND),
    }));
    obj.emailAccountIds = obj.emailAccountIds.map((a) => a._id);
  }

  obj.replyRate = replyRate(obj.stats);
  return obj;
};

// Why can this campaign not go active? Returns a message, or null.
const launchBlocker = ({ accountIds, leadListId, pitches }) => {
  if (!accountIds?.length) return "Select at least one connected mailbox before launching";
  if (!leadListId) return "Select a lead list before launching";
  const hasVariant = (Array.isArray(pitches) ? pitches : []).some((t) => t?.subject && t?.html);
  if (!hasVariant) return "Add a pitch subject and body before launching";
  return null;
};

// -- Endpoints ---------------------------------------------------------------

// GET /campaigns
const list = async (req, res) => {
  const campaigns = await EmailCampaign.find({ userId: req.user.id })
    .populate(POPULATE)
    .sort({ createdAt: -1 });
  return res.json({ ok: true, data: campaigns.map(shape) });
};

// Validate that referenced accounts and list belong to the caller.
const validateRefs = async (userId, accountIds, leadListId) => {
  if (accountIds?.length) {
    const found = await EmailAccount.countDocuments({ _id: { $in: accountIds }, userId });
    if (found !== accountIds.length) return "One or more selected mailboxes were not found";
  }
  if (leadListId) {
    const ll = await EmailLeadList.findOne({ _id: leadListId, userId }).select("importStatus.state");
    if (!ll) return "Selected lead list not found";
    if (ll.importStatus?.state === "importing") {
      return "That lead list is still importing. Wait for it to finish.";
    }
    if (ll.importStatus?.state === "failed") {
      return "That lead list failed to import. Re-upload it.";
    }
  }
  return null;
};

// POST /campaigns
const create = async (req, res) => {
  const userId = req.user.id;
  const {
    name,
    emailAccountIds,
    leadListId,
    pitches,
    followup,
    pacing,
    sendRatePerMin,
    dailyLimit,
    status,
    uniqueEmails,
  } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ message: "Campaign name is required" });
  }

  const existing = await EmailCampaign.findOne({ userId, name: String(name).trim() });
  if (existing) {
    return res.status(400).json({ message: "A campaign with this name already exists" });
  }

  const accountIds = cleanAccountIds(emailAccountIds);
  const pitchTemplates = cleanTemplates(pitches);
  const steps = cleanSteps(followup?.steps);
  const pacingCfg = cleanPacing(pacing);

  const refErr = await validateRefs(userId, accountIds, leadListId);
  if (refErr) return res.status(400).json({ message: refErr });

  const wantsActive = status === "active";
  if (wantsActive) {
    const err = launchBlocker({ accountIds, leadListId, pitches: pitchTemplates });
    if (err) return res.status(400).json({ message: err });
  }

  const total = leadListId ? await getLeadCount(leadListId) : 0;

  const campaign = await EmailCampaign.create({
    userId,
    name: String(name).trim(),
    emailAccountIds: accountIds,
    leadListId: leadListId || null,
    pitches: pitchTemplates,
    followup: { enabled: followup?.enabled ?? true, steps },
    ...(pacingCfg && { pacing: pacingCfg }),
    ...(sendRatePerMin !== undefined && { sendRatePerMin: clamp(sendRatePerMin, 1, 120, 20) }),
    ...(dailyLimit !== undefined && { dailyLimit: clamp(dailyLimit, 1, 100000, 500) }),
    uniqueEmails: !!uniqueEmails,
    stats: { total, sent: 0, replied: 0, followupsSent: 0, failed: 0, bounced: 0, other: 0, queued: 0 },
    status: wantsActive ? "active" : "draft",
  });

  await campaign.populate(POPULATE);
  return res.status(201).json({ message: "Campaign created", data: shape(campaign) });
};

// GET /campaigns/:id -> campaign + one row per recipient
const getOne = async (req, res) => {
  const campaign = await EmailCampaign.findOne({ _id: req.params.id, userId: req.user.id })
    .populate(POPULATE);
  if (!campaign) return res.status(404).json({ message: "Campaign not found" });

  const followupTotal = resolveFollowupSteps(campaign).length;

  const pitchRows = await EmailMessage.find({ campaignId: campaign._id, stage: "pitch" })
    .sort({ createdAt: 1 })
    .select("leadEmail status sentAt repliedAt error subject replyFrom replySnippet bounceReason");

  const followups = await EmailMessage.find({ campaignId: campaign._id, stage: "followup" })
    .select("leadEmail status sentAt followupStep");

  // ONE ROW PER PERSON. Keep the row reflecting the lead's true best outcome: a
  // real reply beats a bounce beats a plain delivery, which all beat a stale
  // queued or failed row.
  const rank = (s) =>
    ({ replied: 6, bounced: 5, soft_bounced: 4, auto_reply: 4, sent: 3, failed: 2, queued: 1 }[s] || 0);

  const pitchByEmail = new Map();
  for (const p of pitchRows) {
    const cur = pitchByEmail.get(p.leadEmail);
    if (!cur || rank(p.status) > rank(cur.status)) pitchByEmail.set(p.leadEmail, p);
  }

  const fuByEmail = new Map();
  for (const f of followups) {
    const arr = fuByEmail.get(f.leadEmail) || [];
    arr.push(f);
    fuByEmail.set(f.leadEmail, arr);
  }
  for (const arr of fuByEmail.values()) {
    arr.sort((a, b) => (a.followupStep ?? 0) - (b.followupStep ?? 0));
  }

  const recipients = Array.from(pitchByEmail.values()).map((p) => {
    const fus = fuByEmail.get(p.leadEmail) || [];
    const delivered = fus.filter((f) => ["sent", "replied", "auto_reply"].includes(f.status));
    // Count DISTINCT steps, not raw rows, so a duplicate row for one step reads
    // "1/1" rather than "4/1".
    const distinctSteps = new Set(delivered.map((f) => f.followupStep ?? 0));
    const sentCount = Math.min(distinctSteps.size, followupTotal);
    const last = delivered.length ? delivered[delivered.length - 1] : null;

    return {
      email: p.leadEmail,
      status: p.status,
      statusLabel: STATUS_LABEL[p.status] || p.status,
      sentAt: p.sentAt,
      repliedAt: p.repliedAt,
      error: p.error,
      subject: p.subject,
      replySnippet: p.replySnippet,
      replyFrom: p.replyFrom,
      bounceReason: p.bounceReason,
      emailCount: 1 + sentCount,
      followupsSent: sentCount,
      followupTotal,
      lastFollowupAt: last?.sentAt || null,
    };
  });

  return res.json({ ok: true, data: shape(campaign), recipients });
};

// PATCH /campaigns/:id
const update = async (req, res) => {
  const campaign = await EmailCampaign.findOne({ _id: req.params.id, userId: req.user.id });
  if (!campaign) return res.status(404).json({ message: "Campaign not found" });

  const b = req.body || {};

  if (b.name !== undefined) campaign.name = String(b.name).trim();
  if (b.uniqueEmails !== undefined) campaign.uniqueEmails = !!b.uniqueEmails;
  if (b.sendRatePerMin !== undefined) campaign.sendRatePerMin = clamp(b.sendRatePerMin, 1, 120, 20);
  if (b.dailyLimit !== undefined) campaign.dailyLimit = clamp(b.dailyLimit, 1, 100000, 500);

  if (b.emailAccountIds !== undefined) {
    const ids = cleanAccountIds(b.emailAccountIds);
    const err = await validateRefs(req.user.id, ids, null);
    if (err) return res.status(400).json({ message: err });
    campaign.emailAccountIds = ids;
  }

  if (b.pacing !== undefined) {
    const cfg = cleanPacing(b.pacing);
    if (cfg) campaign.pacing = cfg;
  }

  if (b.leadListId !== undefined) {
    const nextListId = b.leadListId || null;
    const err = await validateRefs(req.user.id, null, nextListId);
    if (err) return res.status(400).json({ message: err });

    // nextLeadIndex is a positional cursor INTO A SPECIFIC LIST, so it means
    // nothing once the list is swapped. Carrying it over leaves a campaign
    // pointed at a fresh list already "past the end" of it: the scheduler sees
    // nextLeadIndex >= leadCount, marks it completed on the first tick and
    // sends nothing -- which is exactly what someone re-pointing a campaign at
    // a re-uploaded list is trying to recover FROM.
    const listChanged = String(campaign.leadListId || "") !== String(nextListId || "");
    campaign.leadListId = nextListId;

    if (nextListId) campaign.stats.total = await getLeadCount(nextListId);

    if (listChanged) {
      campaign.progress.nextLeadIndex = 0;
      campaign.progress.batchRemaining = 0;
      campaign.progress.nextBatchAt = null;
      campaign.progress.nextSendAt = null;
    }
  }

  if (b.pitches !== undefined) campaign.pitches = cleanTemplates(b.pitches);

  if (b.followup !== undefined) {
    campaign.followup = {
      enabled: b.followup.enabled ?? campaign.followup.enabled,
      steps:
        b.followup.steps !== undefined ? cleanSteps(b.followup.steps) : campaign.followup.steps,
    };
  }

  await campaign.save();
  await campaign.populate(POPULATE);
  return res.json({ message: "Campaign updated", data: shape(campaign) });
};

// PATCH /campaigns/:id/status  { status }
const updateStatus = async (req, res) => {
  const { status } = req.body || {};
  if (!["active", "paused", "completed", "draft"].includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  const campaign = await EmailCampaign.findOne({ _id: req.params.id, userId: req.user.id });
  if (!campaign) return res.status(404).json({ message: "Campaign not found" });

  if (status === "active") {
    const err = launchBlocker({
      accountIds: campaign.emailAccountIds,
      leadListId: campaign.leadListId,
      pitches: campaign.pitches,
    });
    if (err) return res.status(400).json({ message: err });

    // Re-check the referenced mailboxes are still connected and can send.
    const accounts = await EmailAccount.find({ _id: { $in: campaign.emailAccountIds } })
      .select("email connected grantedScopes")
      .lean();
    const unusable = accounts.filter(
      (a) => !a.connected || !(a.grantedScopes || []).includes(SCOPE_SEND)
    );
    if (unusable.length) {
      return res.status(400).json({
        message: `Reconnect ${unusable.map((a) => a.email).join(", ")} -- send permission is missing or revoked.`,
      });
    }
    campaign.stoppedReason = "";
  }

  campaign.status = status;
  await campaign.save();
  await campaign.populate(POPULATE);
  return res.json({ message: "Status updated", data: shape(campaign) });
};

// POST /campaigns/:id/followup-now
const followupNow = async (req, res) => {
  const campaign = await EmailCampaign.findOne({ _id: req.params.id, userId: req.user.id });
  if (!campaign) return res.status(404).json({ message: "Campaign not found" });
  if (!campaign.emailAccountIds?.length) {
    return res.status(400).json({ message: "No mailbox on this campaign" });
  }
  if (!resolveFollowupSteps(campaign).length) {
    return res.status(400).json({ message: "Add at least one follow-up step first" });
  }

  const sent = await sendFollowupBatch(campaign, { ignoreDelay: true, max: 500 });
  const stats = await recomputeCampaignStats(campaign._id);
  return res.json({ ok: true, sent, stats });
};

// POST /campaigns/:id/sync
const sync = async (req, res) => {
  const campaign = await EmailCampaign.findOne({ _id: req.params.id, userId: req.user.id });
  if (!campaign) return res.status(404).json({ message: "Campaign not found" });

  const result = await syncCampaignReplies(campaign, { limit: 100 });
  const stats = await recomputeCampaignStats(campaign._id);
  return res.json({ ok: true, ...result, stats });
};

// POST /campaigns/preview-schedule  { leadListId, pacing, mailboxCount }
// Powers the wizard's live schedule card, using the SAME arithmetic the
// scheduler uses, so the preview cannot drift from reality.
const previewSchedule = async (req, res) => {
  const { leadListId, pacing, mailboxCount } = req.body || {};
  const total = leadListId ? await getLeadCount(leadListId) : 0;
  return res.json({
    ok: true,
    data: computeSchedule(total, cleanPacing(pacing) || {}, mailboxCount || 1),
  });
};

// POST /campaigns/validate-templates  { leadListId, pitches, followup }
// Reports {{tokens}} that would render empty, BEFORE anything is sent.
const validateTemplates = async (req, res) => {
  const { leadListId, pitches, followup } = req.body || {};

  let columns = [];
  if (leadListId) {
    const ll = await EmailLeadList.findOne({ _id: leadListId, userId: req.user.id })
      .select("columns")
      .lean();
    columns = ll?.columns || [];
  }

  const problems = [];
  cleanTemplates(pitches).forEach((t, i) => {
    const bad = [
      ...new Set([
        ...unresolvedTokens(t.subject, columns),
        ...unresolvedTokens(t.html, columns),
      ]),
    ];
    if (bad.length) problems.push({ where: `Pitch variant ${i + 1}`, tokens: bad });
  });

  cleanSteps(followup?.steps).forEach((s, i) => {
    const bad = [
      ...new Set([
        ...unresolvedTokens(s.subject, columns),
        ...unresolvedTokens(s.html, columns),
      ]),
    ];
    if (bad.length) problems.push({ where: `Follow-up ${i + 1}`, tokens: bad });
  });

  return res.json({ ok: true, columns, problems });
};

// DELETE /campaigns/:id
const remove = async (req, res) => {
  const campaign = await EmailCampaign.findOneAndDelete({
    _id: req.params.id,
    userId: req.user.id,
  });
  if (!campaign) return res.status(404).json({ message: "Campaign not found" });

  await EmailMessage.deleteMany({ campaignId: campaign._id }).catch(() => {});
  return res.json({ ok: true });
};

// DELETE /campaigns/:id/recipients?email=...
const removeRecipient = async (req, res) => {
  const email = String(req.query.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ message: "email is required" });

  const campaign = await EmailCampaign.findOne({ _id: req.params.id, userId: req.user.id });
  if (!campaign) return res.status(404).json({ message: "Campaign not found" });

  const { deletedCount } = await EmailMessage.deleteMany({
    campaignId: campaign._id,
    leadEmail: email,
  });
  if (!deletedCount) return res.status(404).json({ message: "Recipient not found" });

  const stats = await recomputeCampaignStats(campaign._id).catch(() => null);
  return res.json({ ok: true, deleted: deletedCount, stats });
};

// -- Activity export ---------------------------------------------------------
// ONE ROW PER EMAIL (unlike getOne, which is one row per person): every pitch
// and every follow-up step, so the sheet answers "which email went to whom,
// when, from which mailbox, and what came back".

const isoLocal = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) : "");

// Strip characters a spreadsheet would evaluate as a formula (CSV injection:
// a cell beginning = + - @ can execute when the file is opened).
const deFormula = (v) => {
  const s = v == null ? "" : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

const csvCell = (v) => `"${deFormula(v).replace(/"/g, '""')}"`;

const EXPORT_COLUMNS = [
  ["Recipient", (m) => m.leadEmail],
  ["Step", (m) => (m.stage === "pitch" ? "Pitch" : `Follow-up ${(m.followupStep ?? 0) + 1}`)],
  ["Variant", (m) => (m.templateIndex == null ? "" : `V${m.templateIndex + 1}`)],
  ["Subject", (m) => m.subject],
  ["From", (m) => m.sendingAccountId?.email || ""],
  ["Status", (m) => STATUS_LABEL[m.status] || m.status],
  ["Sent At", (m) => isoLocal(m.sentAt)],
  ["Replied At", (m) => isoLocal(m.repliedAt)],
  ["Reply From", (m) => m.replyFrom],
  ["Reply Snippet", (m) => m.replySnippet],
  ["Bounced At", (m) => isoLocal(m.bouncedAt)],
  ["Bounce Reason", (m) => m.bounceReason],
  ["Error", (m) => m.error],
  ["Created At", (m) => isoLocal(m.createdAt)],
];

const exportActivity = async (req, res) => {
  const campaign = await EmailCampaign.findOne({ _id: req.params.id, userId: req.user.id });
  if (!campaign) return res.status(404).json({ message: "Campaign not found" });

  const messages = await EmailMessage.find({ campaignId: campaign._id })
    .sort({ leadEmail: 1, stage: -1, followupStep: 1, sentAt: 1 })
    .populate("sendingAccountId", "email")
    .select(
      "leadEmail stage followupStep templateIndex subject status sentAt repliedAt " +
        "bouncedAt bounceReason replyFrom replySnippet error fields sendingAccountId createdAt"
    )
    .lean();

  // Lead columns ride along as trailing columns so the export can be joined
  // back to the source list. Union the keys -- rows may not all carry the same.
  const leadKeys = [];
  const seenKeys = new Set();
  for (const m of messages) {
    for (const k of Object.keys(m.fields || {})) {
      if (k === "email" || seenKeys.has(k)) continue;
      seenKeys.add(k);
      leadKeys.push(k);
    }
  }

  const headers = [...EXPORT_COLUMNS.map(([h]) => h), ...leadKeys];
  const rows = messages.map((m) => [
    ...EXPORT_COLUMNS.map(([, get]) => get(m) ?? ""),
    ...leadKeys.map((k) => m.fields?.[k] ?? ""),
  ]);

  const slug = String(campaign.name || "campaign")
    .replace(/[^a-z0-9]+/gi, "_")
    .slice(0, 40)
    .toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10);

  if (String(req.query.format || "csv").toLowerCase() === "xlsx") {
    const XLSX = require("xlsx");
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows.map((r) => r.map(deFormula))]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Activity");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${slug}_activity_${stamp}.xlsx"`);
    return res.send(buf);
  }

  // Leading BOM so Excel opens the UTF-8 CSV without mojibake.
  const csv = "﻿" + [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${slug}_activity_${stamp}.csv"`);
  return res.send(csv);
};

module.exports = {
  list,
  create,
  getOne,
  update,
  updateStatus,
  followupNow,
  sync,
  previewSchedule,
  validateTemplates,
  remove,
  removeRecipient,
  exportActivity,
};
