// Reply tracking by thread polling -- the SAFETY NET, not the main path.
//
// The main path is historySync.js, which asks each mailbox "what changed since
// cursor X?" for one API call per mailbox per tick. This module exists to cover
// what history cannot:
//   - mail that arrived before a mailbox was first synced (no cursor yet),
//   - gaps after a cursor goes stale (the provider keeps ~7 days of history).
//
// It polls the thread of every outstanding message, least-recently-checked
// first, at a small fixed budget per tick. That ordering is what makes a
// bounded budget eventually cover everything.
//
// A thread lives in the mailbox that SENT it. With several sending accounts on
// one campaign, each message must be polled with ITS OWN account's token --
// asking account A for a thread belonging to account B just 404s.

const { EmailMessage } = require("../../models");
const { header } = require("../gmail/mime");
const { classifyInbound, partsFromGmail } = require("./classifyInbound");
const { PENDING_STATES } = require("./statusSets");
const {
  loadAccountWithTokens,
  getValidAccessTokenForAccount,
  accountHasScope,
  SCOPE_READ,
} = require("../gmail/accountTokens");
const { GMAIL_API } = require("../gmail/sender");

// Headers the classifier reads. Subject + Auto-Submitted + Content-Type +
// X-Failed-Recipients are what tell a MAILER-DAEMON DSN or a vacation responder
// apart from a real human reply.
const META_HEADERS = [
  "From",
  "Date",
  "Subject",
  "Auto-Submitted",
  "Content-Type",
  "X-Failed-Recipients",
  "Precedence",
  "Message-ID",
];

// Look at everything that came back in a thread and resolve ONE outcome.
//
// Not every inbound message is a human reply: a bounce and an out-of-office
// both arrive here too, and counting them as replies is what inflates a reply
// rate. Priority:
//   - a GENUINE human reply wins if present (delivery clearly succeeded);
//   - else a BOUNCE, hard preferred over soft -- terminal, it never arrived;
//   - else only autoresponders or nothing -> { kind: "none" }, keep polling,
//     because a real reply can still follow an out-of-office.
const analyzeThread = (thread, selfEmail, ourMessageId) => {
  const self = String(selfEmail || "").toLowerCase();
  let bounce = null;
  let auto = null;

  for (const m of thread?.messages || []) {
    if (m.id === ourMessageId) continue; // our own outbound pitch
    const from = header(m.payload, "From").toLowerCase();
    if (self && from.includes(self)) continue; // our own follow-ups

    const { type, reason } = classifyInbound(partsFromGmail(m, header));
    if (type === "reply") return { kind: "reply", message: m, reason: "" };
    if (type === "bounced") return { kind: "bounced", message: m, reason }; // hard wins now
    if (type === "soft_bounce") {
      if (!bounce) bounce = { kind: "soft_bounce", message: m, reason };
      continue;
    }
    if (type === "auto_reply") {
      if (!auto) auto = { kind: "auto_reply", message: m, reason: "" };
      continue;
    }
  }

  if (bounce) return bounce;
  if (auto) return auto;
  return { kind: "none" };
};

// When the reply actually landed, per the provider. Falls back to `now` for a
// message that reports no internalDate, so repliedAt is never null on a
// replied row.
const eventTime = (msg, now) => {
  const ms = Number(msg?.internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : now;
};

// Resolve an account id to { account, accessToken } or { error }. Cached per
// sync call, so a campaign sending from N mailboxes does N token refreshes,
// not one per message.
const makeAccountResolver = () => {
  const cache = new Map();
  return async (accountId) => {
    const key = String(accountId || "");
    if (!key) return { error: "no_account" };
    if (cache.has(key)) return cache.get(key);

    let entry;
    const account = await loadAccountWithTokens(key);
    if (!account) entry = { error: "account_not_found" };
    else if (!accountHasScope(account, SCOPE_READ)) entry = { error: "scope_not_granted" };
    else {
      try {
        entry = { account, accessToken: await getValidAccessTokenForAccount(account) };
      } catch (e) {
        entry = { error: e.message };
      }
    }
    cache.set(key, entry);
    return entry;
  };
};

// Fetch a message's thread and classify its outcome. Extracted so the live
// sweep and any backfill run the SAME detection.
const fetchThreadOutcome = async (msg, account, accessToken) => {
  const url = new URL(`${GMAIL_API}/threads/${msg.threadId}`);
  url.searchParams.set("format", "metadata");
  for (const h of META_HEADERS) url.searchParams.append("metadataHeaders", h);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  return res.ok ? analyzeThread(data, account.email, msg.gmailMessageId) : { kind: "none" };
};

// Apply an outcome to a message row (MUTATES, does not save). Returns
// { becameReply } so callers can count NEW replies. Shared by both sync paths,
// which is what keeps them from disagreeing about what a reply is.
const applyOutcome = (msg, outcome, now) => {
  const m = outcome.message;

  if (outcome.kind === "reply") {
    const wasReplied = msg.status === "replied";
    msg.status = "replied";
    msg.repliedAt = eventTime(m, now);
    // Keep who answered and the provider's preview line, so the conversation
    // view has something even if read access is later revoked.
    msg.replyFrom = header(m.payload, "From");
    msg.replySnippet = m.snippet || "";
    msg.bouncedAt = null;
    msg.bounceReason = "";
    return { becameReply: !wasReplied };
  }

  if (outcome.kind === "bounced" || outcome.kind === "soft_bounce") {
    // Terminal: the send never reached the lead. Record who and why for the UI,
    // and clear any stale reply attribution.
    msg.status = outcome.kind === "bounced" ? "bounced" : "soft_bounced";
    msg.bouncedAt = eventTime(m, now);
    msg.bounceReason = outcome.reason || "";
    msg.replyFrom = header(m.payload, "From");
    msg.replySnippet = m.snippet || "";
    msg.repliedAt = null;
    return { becameReply: false };
  }

  if (outcome.kind === "auto_reply") {
    // NOT terminal -- keep polling for a real reply -- but flag it so it is not
    // counted as one and shows in the "other" bucket meanwhile.
    msg.status = "auto_reply";
    msg.replyFrom = header(m.payload, "From");
    msg.replySnippet = m.snippet || "";
    msg.repliedAt = null;
    return { becameReply: false };
  }

  return { becameReply: false }; // "none" -- leave as-is
};

// Sync replies for one campaign. Bounded by `limit` so a tick stays cheap.
const syncCampaignReplies = async (campaign, { limit = 25 } = {}) => {
  const accountIds = Array.isArray(campaign?.emailAccountIds) ? campaign.emailAccountIds : [];
  if (!accountIds.length) return { ok: false, error: "no_account" };

  // Outbound messages not yet resolved to a terminal outcome, least-recently
  // checked first.
  const pending = await EmailMessage.find({
    campaignId: campaign._id,
    status: { $in: PENDING_STATES },
    threadId: { $ne: "" },
  })
    .sort({ lastCheckedAt: 1 })
    .limit(Math.min(Math.max(Number(limit) || 25, 1), 100));

  if (!pending.length) return { ok: true, checked: 0, newReplies: 0 };

  const resolveAccount = makeAccountResolver();
  const now = new Date();
  let newReplies = 0;
  let checked = 0;
  let lastError = "";

  for (const msg of pending) {
    const accountId = msg.sendingAccountId || accountIds[0];
    const { account, accessToken, error } = await resolveAccount(accountId);
    if (error) {
      lastError = error; // e.g. this mailbox never granted read scope
      continue;
    }

    try {
      const outcome = await fetchThreadOutcome(msg, account, accessToken);
      checked += 1;
      msg.lastCheckedAt = now;
      const { becameReply } = applyOutcome(msg, outcome, now);
      if (becameReply) newReplies += 1;
      await msg.save().catch(() => {});
    } catch {
      // Transient fetch error -- leave this message for the next sweep.
    }
  }

  // Nothing could be checked and every account errored: surface the reason
  // rather than reporting a clean sweep of zero.
  if (!checked && lastError) return { ok: false, error: lastError };

  return { ok: true, checked, newReplies };
};

module.exports = {
  syncCampaignReplies,
  makeAccountResolver,
  fetchThreadOutcome,
  applyOutcome,
  analyzeThread,
  META_HEADERS,
};
