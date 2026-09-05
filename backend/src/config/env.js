// Central environment access. One place to read and validate configuration so
// feature code never greps process.env directly.

require("dotenv").config();

const env = (k, dflt = "") => (process.env[k] || dflt).trim();
const num = (k, dflt) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const nodeEnv = env("NODE_ENV", "development").toLowerCase();

// Which subsystems this process runs. Splitting them lets you scale sending
// independently of the API without running duplicate schedulers (the Redis
// leader lock would prevent double-sending anyway, but why pay for it).
const ROLES = env("ROLES", "api,scheduler,worker")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const config = {
  nodeEnv,
  isProd: nodeEnv === "production",
  port: num("PORT", 4000),
  publicUrl: env("PUBLIC_URL", "http://localhost:4000").replace(/\/+$/, ""),
  frontendUrl: env("FRONTEND_URL", "http://localhost:3000").replace(/\/+$/, ""),

  mongoUri: env("MONGODB_URI", "mongodb://127.0.0.1:27018/email_campaigning"),
  redisUrl: env("REDIS_URL"),

  // Optional override for the nameservers Node's own resolver uses to look up
  // a mongodb+srv:// seed list. Only needed on hosts whose DNS config Node
  // cannot read -- see the comment in config/db.js. Empty means "trust the
  // host", which is the right answer nearly everywhere.
  dnsServers: env("DNS_SERVERS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  jwtSecret: env("JWT_SECRET"),
  jwtExpiresIn: env("JWT_EXPIRES_IN", "30d"),
  tokenEncKey: env("TOKEN_ENC_KEY"),

  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
    redirectUri: env("GOOGLE_REDIRECT_URI"),
  },

  ai: {
    geminiKey: env("GEMINI_API_KEY"),
    openaiKey: env("OPENAI_API_KEY"),
    rewriteModel: env("AI_REWRITE_MODEL", "gemini-2.5-flash"),
    templateModel: env("AI_TEMPLATE_MODEL", "gpt-4o-mini"),
  },

  roles: {
    all: ROLES,
    api: ROLES.includes("api"),
    scheduler: ROLES.includes("scheduler"),
    worker: ROLES.includes("worker"),
  },
};

// Fail fast on anything that cannot be defaulted. A missing JWT secret or
// encryption key is a silent security hole, not an inconvenience.
const validate = () => {
  const fatal = [];
  const warn = [];

  if (!config.jwtSecret || config.jwtSecret.length < 24) {
    fatal.push("JWT_SECRET is missing or too short (needs >= 24 chars).");
  }
  if (!config.tokenEncKey || config.tokenEncKey.length < 32) {
    fatal.push("TOKEN_ENC_KEY is missing or too short (needs >= 32 chars).");
  }
  if (!config.mongoUri) fatal.push("MONGODB_URI is required.");

  if (!config.redisUrl) {
    warn.push(
      "REDIS_URL is not set. The queue, the leader lock and per-mailbox rate " +
      "limiting are all DISABLED, so no campaign email can be delivered."
    );
  }
  if (!config.google.clientId || !config.google.clientSecret || !config.google.redirectUri) {
    warn.push(
      "Google OAuth is not fully configured — mailboxes cannot be connected " +
      "(set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)."
    );
  }
  if (!config.ai.geminiKey && !config.ai.openaiKey) {
    warn.push(
      "No AI key set — per-recipient rewriting sends the original copy and AI " +
      "template drafting is unavailable. Everything else works normally."
    );
  }

  return { fatal, warn };
};

module.exports = { config, validate, env, num };
