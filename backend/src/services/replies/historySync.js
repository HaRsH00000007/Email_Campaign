// Incremental reply and bounce detection, per MAILBOX, via Gmail's history API.
//
// THE PROBLEM THIS SOLVES
//
// Thread polling (replySync.js) has two fatal properties as a primary strategy:
//
//   1. Cost scales with TOTAL MAIL EVER SENT, not with inbound activity. At a
//      fixed budget per tick, a large campaign takes HOURS to sweep once -- so
//      reply-detection latency grows linearly with campaign size, forever.
//   2. "sent" is never terminal (a reply can always arrive), so the set of
//      messages to poll only ever grows.
//
// THE FIX
//
// Ask each mailbox "what has changed since history cursor X?" -- ONE call per
// mailbox per tick, regardless of how much mail that mailbox has ever sent.
// Then look only at messages that actually arrived, and only the ones landing
// in a thread we care about.
//
// Cost goes from O(messages ever sent) to O(new inbound messages). A mailbox
// with no new mail costs exactly one API call.
//
// WHY replySync STAYS
//
// Gmail retains history for only about a week. A cursor older than that is
// rejected, and a mailbox we have never synced has no cursor at all -- so
// anything that arrived before we started watching is invisible to this path.
// replySync remains a low-rate reconciliation for exactly those gaps. This is a
// fast path, not a replacement for durable reconciliation.
//
// Classification is NOT reimplemented here -- it is imported from replySync, so
// both paths decide "reply vs bounce vs auto-reply" identically. That shared
// decision is what keeps the reply rate honest.

const { EmailAccount, EmailMessage } = require("../../models");
const { header } = require("../gmail/mime");
const { applyOutcome, META_HEADERS } = require("./replySync");
const { classifyInbound, partsFromGmail } = require("./classifyInbound");
const { PENDING_STATES } = require("./statusSets");
const {
  loadAccountWithTokens,
  getValidAccessTokenForAccount,
  accountHasScope,
  noteAccountError,
  SCOPE_READ,
} = require("../gmail/accountTokens");
const { GMAIL_API } = require("../gmail/sender");

const authed = (accessToken) => ({ headers: { Authorization: `Bearer ${accessToken}` } });

// The mailbox's current history cursor -- used to baseline a mailbox we have
// never synced.
const fetchProfileHistoryId = async (accessToken) => {
  const res = await fetch(`${GMAIL_API}/profile`, authed(accessToken));
  if (!res.ok) throw new Error(`gmail_profile_${res.status}`);
  const data = await res.json();
  return String(data.historyId || "");
};

// Everything added to the mailbox since `startHistoryId`.
//
// Returns { messages: [{id, threadId}], historyId, expired }. `expired: true`
// means the cursor was rejected as too old (404) -- the caller must re-baseline
// and let the thread-poll safety net cover the gap.
const fetchHistory = async (accessToken, startHistoryId) => {
  const out = [];
  let pageToken;
  let latestHistoryId = startHistoryId;
  let pages = 0;

  do {
    const url = new URL(`${GMAIL_API}/history`);
    url.searchParams.set("startHistoryId", String(startHistoryId));
    // Only additions matter; label changes and deletions are noise here.
    url.searchParams.set("historyTypes", "messageAdded");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, authed(accessToken));
    if (res.status === 404) return { messages: [], historyId: null, expired: true };
    if (!res.ok) throw new Error(`gmail_history_${res.status}`);

    const data = await res.json();
    if (data.historyId) latestHistoryId = String(data.historyId);

    for (const h of data.history || []) {
      for (const added of h.messagesAdded || []) {
        const m = added.message;
        if (!m?.id || !m?.threadId) continue;
        // Skip our OWN outbound: the provider records a send as a messageAdded
        // too, and fetching every one of those puts us right back at O(sent).
        if ((m.labelIds || []).includes("SENT")) continue;
        out.push({ id: m.id, threadId: m.threadId });
      }
    }

    pageToken = data.nextPageToken;
    pages += 1;
    // Defensive ceiling: a mailbox that has been idle for days can return a lot
    // of pages. Stop and let the next tick continue from the advanced cursor.
  } while (pageToken && pages < 20);

  return { messages: out, historyId: latestHistoryId, expired: false };
};

const fetchMessageMeta = async (accessToken, messageId) => {
  const url = new URL(`${GMAIL_API}/messages/${messageId}`);
  url.searchParams.set("format", "metadata");
  for (const h of META_HEADERS) url.searchParams.append("metadataHeaders", h);
  const res = await fetch(url, authed(accessToken));
  if (!res.ok) return null;
  return res.json();
};

// Sync one mailbox. Returns { ok, checked, newReplies, baselined?, expired? }.
const syncAccount = async (accountId) => {
  const account = await loadAccountWithTokens(accountId);
  if (!account) return { ok: false, error: "account_not_found" };
  if (!account.connected) return { ok: false, error: "not_connected" };

  // Without read scope this mailbox can send but we can never see its replies.
  // Surfaced on the account so the UI can say so, rather than silently never
  // detecting a reply.
  if (!accountHasScope(account, SCOPE_READ)) {
    await noteAccountError(accountId, "gmail.readonly not granted -- replies cannot be detected");
    return { ok: false, error: "scope_not_granted" };
  }

  let accessToken;
  try {
    accessToken = await getValidAccessTokenForAccount(account);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // -- Baseline a mailbox we have never synced -------------------------------
  // We deliberately do NOT try to replay history from before this point: the
  // provider does not keep it, and anything already in the inbox is the safety
  // net's job.
  if (!account.historyId) {
    try {
      const historyId = await fetchProfileHistoryId(accessToken);
      await EmailAccount.updateOne(
        { _id: account._id },
        { historyId, historySyncedAt: new Date() }
      );
      return { ok: true, checked: 0, newReplies: 0, baselined: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // -- Incremental -----------------------------------------------------------
  let history;
  try {
    history = await fetchHistory(accessToken, account.historyId);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  if (history.expired) {
    try {
      const historyId = await fetchProfileHistoryId(accessToken);
      await EmailAccount.updateOne(
        { _id: account._id },
        { historyId, historySyncedAt: new Date() }
      );
    } catch {
      /* next tick retries */
    }
    console.warn(
      `[historySync] ${account.email}: cursor expired (>7d stale) -- re-baselined. ` +
        "The thread-poll safety net will reconcile anything missed."
    );
    return { ok: true, checked: 0, newReplies: 0, expired: true };
  }

  if (!history.messages.length) {
    // Nothing new. Still advance the cursor so this range is not re-scanned.
    if (history.historyId && history.historyId !== account.historyId) {
      await EmailAccount.updateOne(
        { _id: account._id },
        { historyId: history.historyId, historySyncedAt: new Date() }
      ).catch(() => {});
    }
    return { ok: true, checked: 0, newReplies: 0 };
  }

  // -- Narrow to threads we actually care about ------------------------------
  // Most inbound mail in a real mailbox has nothing to do with our campaigns.
  // One indexed query tells us which of these threads belong to a message we
  // are still waiting on, so we only pay for message fetches that can change
  // state.
  const threadIds = [...new Set(history.messages.map((m) => m.threadId))];
  const rows = await EmailMessage.find({
    threadId: { $in: threadIds },
    status: { $in: PENDING_STATES },
  });

  if (!rows.length) {
    await EmailAccount.updateOne(
      { _id: account._id },
      { historyId: history.historyId, historySyncedAt: new Date() }
    ).catch(() => {});
    return { ok: true, checked: 0, newReplies: 0 };
  }

  // A thread can hold several of our rows (a pitch and its follow-ups). An
  // inbound reply resolves ALL of them -- that is what stops the sequence.
  const rowsByThread = new Map();
  for (const r of rows) {
    const arr = rowsByThread.get(String(r.threadId)) || [];
    arr.push(r);
    rowsByThread.set(String(r.threadId), arr);
  }

  const now = new Date();
  const selfEmail = String(account.email).toLowerCase();
  let checked = 0;
  let newReplies = 0;

  for (const { id, threadId } of history.messages) {
    const targets = rowsByThread.get(String(threadId));
    if (!targets?.length) continue;

    const msg = await fetchMessageMeta(accessToken, id);
    if (!msg) continue;

    // Ignore anything we sent ourselves -- our own follow-ups thread here too.
    const from = header(msg.payload, "From").toLowerCase();
    if (from.includes(selfEmail)) continue;

    const { type, reason } = classifyInbound(partsFromGmail(msg, header));
    if (type === "none") continue;

    const outcome = {
      kind: type === "soft_bounce" ? "soft_bounce" : type,
      message: msg,
      reason: reason || "",
    };

    for (const row of targets) {
      // A genuine reply is terminal and must not be downgraded by a later
      // autoresponder arriving in the same thread.
      if (row.status === "replied" && type !== "reply") continue;

      row.lastCheckedAt = now;
      const { becameReply } = applyOutcome(row, outcome, now);
      await row.save().catch(() => {});
      checked += 1;
      if (becameReply) newReplies += 1;
    }
  }

  await EmailAccount.updateOne(
    { _id: account._id },
    { historyId: history.historyId, historySyncedAt: new Date() }
  ).catch(() => {});

  return { ok: true, checked, newReplies };
};

// Sync every given mailbox. One pass = one history call per mailbox, plus a
// message fetch per relevant inbound message. Independent of how many campaigns
// or sent messages exist.
const syncAllAccounts = async (accountIds) => {
  const ids = [...new Set((accountIds || []).map(String))].filter(Boolean);
  let checked = 0;
  let newReplies = 0;

  for (const id of ids) {
    try {
      const r = await syncAccount(id);
      if (r.ok) {
        checked += r.checked || 0;
        newReplies += r.newReplies || 0;
      }
    } catch (e) {
      console.error(`[historySync] account=${id} failed:`, e.message);
    }
  }

  return { checked, newReplies, mailboxes: ids.length };
};

module.exports = { syncAccount, syncAllAccounts };
