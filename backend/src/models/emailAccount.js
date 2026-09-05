// A connected Gmail sending mailbox. One document = one OAuth grant.
//
// A user may connect many mailboxes and a campaign may send from several of
// them at once, rotating round-robin. Splitting volume across mailboxes is the
// correct way to scale cold outreach — raising a single mailbox's limit is not.

const mongoose = require("mongoose");

const emailAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Only Gmail is implemented. The field exists so a second transport can be
    // added without a migration — see services/gmail/sender.js for the seam.
    provider: { type: String, enum: ["gmail"], default: "gmail" },

    // Sends go FROM here, so replies land back in this inbox — which is what
    // reply tracking reads.
    email: { type: String, required: true, lowercase: true, trim: true },

    connected: { type: Boolean, default: true },

    // Exactly which scopes were consented to. A user can untick one on Google's
    // consent screen, so we check gmail.send and gmail.readonly independently
    // rather than assuming a full grant.
    grantedScopes: { type: [String], default: [] },

    // Encrypted at rest (AES-256-GCM, see utils/tokenCrypto). select:false so
    // they are never returned unless a caller explicitly asks.
    refreshToken: { type: String, default: "", select: false },
    accessToken: { type: String, default: "", select: false },
    expiryMs: { type: Number, default: 0 },

    // ── Per-mailbox send limits ──────────────────────────────────────────────
    // NEW relative to the reference implementation, which only had global env
    // limits. Gmail's ceiling differs by account type (~2000/day Workspace,
    // ~500/day consumer) and a warming mailbox should send far less than
    // either. null means "use the server default".
    dailyLimit: { type: Number, default: null, min: 1, max: 5000 },
    hourlyLimit: { type: Number, default: null, min: 1, max: 1000 },

    // ── Incremental reply sync ───────────────────────────────────────────────
    // Gmail's history cursor. We ask "what changed since historyId?" — one API
    // call per mailbox per tick — instead of re-polling the thread of every
    // message ever sent, which got slower the more mail went out.
    //
    // A String because Gmail history IDs are uint64 and exceed the precision of
    // a JS Number. Empty = never synced; the first sync baselines it.
    historyId: { type: String, default: "" },

    // Gmail retains roughly a week of history. A cursor older than that is
    // rejected (404), so we re-baseline and let the thread-poll safety net
    // reconcile the gap.
    historySyncedAt: { type: Date, default: null },

    // Last error surfaced while using this mailbox, for the UI to explain why a
    // campaign stalled (revoked grant, missing scope) without digging in logs.
    lastError: { type: String, default: "" },
    lastErrorAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One row per mailbox per user — reconnecting the same address updates in place.
emailAccountSchema.index({ userId: 1, email: 1 }, { unique: true });
emailAccountSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("EmailAccount", emailAccountSchema);
