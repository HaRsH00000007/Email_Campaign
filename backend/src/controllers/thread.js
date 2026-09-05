// The full conversation with ONE lead in a campaign.
//
// Two sources, because neither alone is enough:
//
//   - Our message rows are authoritative for OUTBOUND. They hold the exact
//     rendered copy that went out (variant chosen at random, {{fields}} filled
//     in, per-recipient rewrite applied) -- the campaign template can no longer
//     reproduce it. They also survive read access being revoked.
//
//   - The provider is the only source for INBOUND. We fetch the thread live to
//     get reply bodies. If that fails (no read scope, revoked grant, API down)
//     we degrade to the snippet stored on the row, and SAY SO rather than
//     pretending the reply was empty.
//
// SECURITY: inbound bodies are attacker-controlled -- anyone can reply to a
// cold email with a payload. They are returned as PLAIN TEXT only, never HTML,
// so the dashboard has no injection sink to render into. Outbound HTML is our
// own and is returned as-is.

const { EmailCampaign, EmailMessage } = require("../models");
const { header, extractBody } = require("../services/gmail/mime");
const {
  loadAccountWithTokens,
  getValidAccessTokenForAccount,
  accountHasScope,
  SCOPE_READ,
} = require("../services/gmail/accountTokens");
const { GMAIL_API } = require("../services/gmail/sender");

// Where a reply's quoted history begins: the "On <date>, <someone> wrote:"
// attribution line, or a run of "> " markers. Everything from there down is our
// own email echoed back, which is already shown above it in the thread.
const QUOTE_MARKERS = [
  /^\s*On .+ wrote:\s*$/im,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^\s*_{5,}\s*$/m,
  /^\s*>/m,
];

// Split a reply into what the person typed and the quoted tail.
const splitQuoted = (text) => {
  const body = String(text || "");
  let cut = -1;
  for (const re of QUOTE_MARKERS) {
    const m = body.match(re);
    if (m && m.index !== undefined && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut === -1) return { text: body.trim(), quoted: "" };

  const above = body.slice(0, cut).trim();
  // Bottom-posting: they replied UNDER the quote (or inline within it), so
  // there is nothing above the cut. Hiding the quote would hide their entire
  // message -- show the whole body instead.
  if (!above) return { text: body.trim(), quoted: "" };

  return { text: above, quoted: body.slice(cut).trim() };
};

// "Display Name <addr@x.com>" -> "addr@x.com"
const addressOf = (from) => {
  const m = String(from || "").match(/<([^>]+)>/);
  return (m ? m[1] : String(from || "")).trim().toLowerCase();
};

const timeOf = (msg) => {
  const ms = Number(msg?.internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
};

const fetchThread = async (accessToken, threadId) => {
  try {
    const res = await fetch(`${GMAIL_API}/threads/${threadId}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error?.message || `gmail_thread_${res.status}` };
    return { ok: true, messages: data.messages || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

// GET /campaigns/:id/thread?email=lead@example.com
const getThread = async (req, res) => {
  const email = String(req.query.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ message: "email is required" });

  const campaign = await EmailCampaign.findOne({ _id: req.params.id, userId: req.user.id });
  if (!campaign) return res.status(404).json({ message: "Campaign not found" });

  const rows = await EmailMessage.find({ campaignId: campaign._id, leadEmail: email })
    .sort({ createdAt: 1 })
    .lean();
  if (!rows.length) return res.status(404).json({ message: "No messages for that recipient" });

  // Everything we sent, from our own records.
  const outbound = rows
    .filter((r) => r.sentAt)
    .map((r) => ({
      direction: "outbound",
      at: r.sentAt,
      stage: r.stage,
      step: r.stage === "followup" ? (r.followupStep ?? 0) + 1 : null,
      subject: r.subject,
      html: r.bodyHtml, // our own markup -- safe to render
      status: r.status,
    }));

  // Inbound, live from the provider.
  const threadIds = [...new Set(rows.map((r) => r.threadId).filter(Boolean))];
  const accountId = rows.find((r) => r.sendingAccountId)?.sendingAccountId;

  let inbound = [];
  let degraded = null;

  if (!threadIds.length || !accountId) {
    degraded = "no_thread";
  } else {
    const account = await loadAccountWithTokens(accountId);
    if (!account) degraded = "account_not_found";
    else if (!accountHasScope(account, SCOPE_READ)) degraded = "scope_not_granted";
    else {
      try {
        const accessToken = await getValidAccessTokenForAccount(account);
        const selfEmail = String(account.email).toLowerCase();
        const ourGmailIds = new Set(rows.map((r) => r.gmailMessageId).filter(Boolean));

        for (const tid of threadIds) {
          const t = await fetchThread(accessToken, tid);
          if (!t.ok) {
            degraded = t.error;
            continue;
          }
          for (const m of t.messages) {
            if (ourGmailIds.has(m.id)) continue;
            const from = header(m.payload, "From");
            if (addressOf(from) === selfEmail) continue; // our own follow-ups

            const raw = extractBody(m.payload);
            const { text, quoted } = splitQuoted(raw);
            inbound.push({
              direction: "inbound",
              at: timeOf(m),
              from,
              subject: header(m.payload, "Subject"),
              // PLAIN TEXT ONLY. Never HTML -- see the header comment.
              text,
              quoted,
              snippet: m.snippet || "",
            });
          }
        }
      } catch (e) {
        degraded = e.message;
      }
    }
  }

  // Fall back to the snippets stored at detection time, so the view is never
  // simply blank when live fetch is unavailable.
  if (degraded && !inbound.length) {
    inbound = rows
      .filter((r) => r.replySnippet || r.replyFrom)
      .map((r) => ({
        direction: "inbound",
        at: r.repliedAt || r.bouncedAt,
        from: r.replyFrom,
        subject: "",
        text: r.replySnippet,
        quoted: "",
        snippet: r.replySnippet,
        partial: true,
      }));
  }

  const messages = [...outbound, ...inbound].sort(
    (a, b) => new Date(a.at || 0) - new Date(b.at || 0)
  );

  return res.json({
    ok: true,
    data: {
      lead: email,
      campaignId: campaign._id,
      messages,
      // Tell the UI when inbound is incomplete, and why, rather than letting it
      // silently show an empty conversation.
      degraded: degraded || null,
    },
  });
};

module.exports = { getThread };
