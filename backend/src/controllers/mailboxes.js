// Connected sending mailboxes: OAuth connect, list, configure limits, remove.
//
// ADAPTED. The reference implementation rode a SHARED Google callback belonging
// to a Calendar integration, dispatching back to email handling based on a type
// tag inside the signed state. That coupling existed to avoid registering a
// second redirect URI in Google Console. Standalone, this owns its own callback
// outright, which is both simpler and a smaller consent scope.

const jwt = require("jsonwebtoken");
const { EmailAccount, EmailMessage } = require("../models");
const oauth = require("../services/gmail/oauth");
const { encrypt, decrypt } = require("../utils/tokenCrypto");
const { usage, limitsFor } = require("../services/rateLimit/mailboxLimiter");
const { config } = require("../config/env");

const STATE_TTL = "10m";

// GET /mailboxes/connect -> { url }
// The signed state carries the user id, so the callback can attribute the grant
// without a session cookie, and expires quickly so a leaked URL is not reusable.
const connect = async (req, res) => {
  if (!oauth.isConfigured()) {
    return res.status(500).json({
      message:
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET " +
        "and GOOGLE_REDIRECT_URI in the backend .env.",
    });
  }

  const state = jwt.sign({ uid: req.user.id, t: "mailbox" }, config.jwtSecret, {
    expiresIn: STATE_TTL,
  });

  return res.json({ url: oauth.buildAuthUrl(state) });
};

// GET /mailboxes/oauth/callback?code=...&state=...
// Google redirects the BROWSER here, so this responds with a redirect back to
// the frontend rather than JSON.
const callback = async (req, res) => {
  const back = (params) =>
    res.redirect(`${config.frontendUrl}/mailboxes?${new URLSearchParams(params)}`);

  const { code, state, error: oauthError } = req.query;
  if (oauthError) return back({ connected: "0", error: String(oauthError) });
  if (!code || !state) return back({ connected: "0", error: "missing_code" });

  let uid;
  try {
    const decoded = jwt.verify(String(state), config.jwtSecret);
    if (decoded.t !== "mailbox") throw new Error("wrong_state_type");
    uid = decoded.uid;
  } catch {
    return back({ connected: "0", error: "invalid_state" });
  }

  try {
    const { accessToken, refreshToken, expiryMs, scope } = await oauth.exchangeCode(String(code));

    const email = await oauth.fetchUserEmail(accessToken);
    if (!email) return back({ connected: "0", error: "could_not_read_email" });

    const grantedScopes = scope ? scope.split(" ").filter(Boolean) : [];

    // Reconnecting the same mailbox updates in place. Google only returns a
    // refresh_token on first consent -- prompt=consent normally forces one, but
    // keep the existing token if a re-consent omits it, or the mailbox would
    // silently lose the ability to refresh.
    const existing = await EmailAccount.findOne({ userId: uid, email }).select("+refreshToken");

    const update = {
      userId: uid,
      provider: "gmail",
      email,
      connected: true,
      grantedScopes,
      accessToken: encrypt(accessToken),
      expiryMs,
      lastError: "",
      lastErrorAt: null,
    };
    if (refreshToken) update.refreshToken = encrypt(refreshToken);
    else if (existing?.refreshToken) update.refreshToken = existing.refreshToken;

    if (!update.refreshToken) {
      return back({ connected: "0", error: "no_refresh_token" });
    }

    await EmailAccount.findOneAndUpdate(
      { userId: uid, email },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const canRead = grantedScopes.includes(oauth.SCOPE_READ);
    return back({ connected: "1", email, ...(canRead ? {} : { warn: "no_read_scope" }) });
  } catch (err) {
    return back({ connected: "0", error: err.message });
  }
};

// GET /mailboxes -> connected mailboxes with live quota usage
const list = async (req, res) => {
  const accounts = await EmailAccount.find({ userId: req.user.id })
    .sort({ createdAt: -1 })
    .lean();

  const data = await Promise.all(
    accounts.map(async (a) => ({
      _id: a._id,
      email: a.email,
      provider: a.provider,
      connected: a.connected,
      canSend: (a.grantedScopes || []).includes(oauth.SCOPE_SEND),
      // Without read scope a mailbox can send, but replies and bounces are
      // invisible for it. Surfaced so the UI can warn rather than leaving the
      // operator wondering why nothing ever gets marked replied.
      canReadReplies: (a.grantedScopes || []).includes(oauth.SCOPE_READ),
      dailyLimit: a.dailyLimit,
      hourlyLimit: a.hourlyLimit,
      lastError: a.lastError || "",
      lastErrorAt: a.lastErrorAt,
      historySyncedAt: a.historySyncedAt,
      createdAt: a.createdAt,
      usage: await usage(a._id, limitsFor(a)),
    }))
  );

  return res.json({ ok: true, data });
};

// PATCH /mailboxes/:id  { dailyLimit?, hourlyLimit? }
const update = async (req, res) => {
  const patch = {};
  const clamp = (v, lo, hi) => {
    if (v === null || v === "") return null; // null = fall back to the server default
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
  };

  if (req.body?.dailyLimit !== undefined) {
    const v = clamp(req.body.dailyLimit, 1, 5000);
    if (v !== undefined) patch.dailyLimit = v;
  }
  if (req.body?.hourlyLimit !== undefined) {
    const v = clamp(req.body.hourlyLimit, 1, 1000);
    if (v !== undefined) patch.hourlyLimit = v;
  }

  const account = await EmailAccount.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { $set: patch },
    { new: true }
  ).lean();

  if (!account) return res.status(404).json({ message: "Mailbox not found" });
  return res.json({ ok: true, data: { _id: account._id, dailyLimit: account.dailyLimit, hourlyLimit: account.hourlyLimit } });
};

// DELETE /mailboxes/:id
// Refuses while campaigns still reference the mailbox, because deleting it
// would strand their in-flight follow-ups (which must send from the mailbox
// that sent the pitch).
const remove = async (req, res) => {
  const account = await EmailAccount.findOne({
    _id: req.params.id,
    userId: req.user.id,
  }).select("+refreshToken");

  if (!account) return res.status(404).json({ message: "Mailbox not found" });

  const inUse = await EmailMessage.countDocuments({
    sendingAccountId: account._id,
    status: "queued",
  });
  if (inUse > 0 && String(req.query.force || "") !== "1") {
    return res.status(409).json({
      message: `${inUse} email(s) are still queued from this mailbox. Pause those campaigns first, or pass ?force=1.`,
    });
  }

  // Best effort: revoke the grant so it does not linger in the user's Google
  // account after they removed it here.
  await oauth.revokeToken(decrypt(account.refreshToken)).catch(() => {});
  await EmailAccount.deleteOne({ _id: account._id });

  return res.json({ ok: true });
};

module.exports = { connect, callback, list, update, remove };
