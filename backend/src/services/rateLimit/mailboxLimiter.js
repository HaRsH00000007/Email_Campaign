// Per-MAILBOX send pacing. Redis-backed, atomic, multi-instance safe.
//
// WHY THIS EXISTS
//
// Campaign-level pacing (sendRatePerMin, spread mode) throttles a CAMPAIGN. It
// cannot throttle a MAILBOX, and those are not the same thing:
//
//   - Two campaigns sharing one mailbox each run at their own full rate, and
//     neither knows about the other.
//   - Spread mode paces inside ONE campaign's send loop, so a retry, a second
//     scheduler, or a manual "follow up now" sails straight past it.
//
// This layer is the single chokepoint every outbound email passes through, so
// it is the only place where "one mailbox, one email per minute" can actually
// be guaranteed.
//
// WHAT IS ENFORCED (and what is deliberately NOT)
//
// 1. MINIMUM SPACING -- the primary control. At least MAILBOX_MIN_SPACING_MS
//    between two consecutive sends from the SAME mailbox. Default 60000.
//    This is what produces the ~1 email/60s cadence. It is per mailbox: a
//    second mailbox is completely unaffected and sends on its own clock.
//
// 2. HOURLY CEILING -- optional, OFF by default. An independent safeguard for
//    operators who want a hard volume brake. See the note below on how it
//    interacts with spacing.
//
// 3. DAILY COUNT -- COUNTED, NEVER ENFORCED. Deliberate. A campaign must not
//    stop because an application-configured daily quota ran out; it stops when
//    the leads run out, when a human pauses it, or when GOOGLE says stop. The
//    day counter is kept purely so the UI can show "N sent today". There is no
//    code path in which it denies a send -- this is implemented as an explicit
//    absence of a check in CONSUME below, NOT as a very large limit.
//
// 4. PROVIDER COOLDOWN -- set by the worker when Gmail returns a real rate
//    limit or quota error. THIS one does stop sending, because it reflects an
//    actual provider restriction rather than a number we invented. It applies
//    to the whole mailbox, so every worker and every campaign defers together
//    instead of each discovering the 429 on its own and burning an attempt to
//    learn it.
//
// HOURLY CEILING vs 60s SPACING. 60s spacing already caps a mailbox at 60/hour,
// so MAILBOX_HOURLY_LIMIT only has an effect below 60 -- and below 60 it is a
// STRICTER brake that idles the mailbox for the remainder of the clock hour
// once hit, which is exactly the stop-and-wait behaviour the spacing rule is
// meant to replace. Leave it unset unless you specifically want that. Anything
// >= 60 is inert, and we say so at startup rather than letting you believe it
// is doing something.
//
// REAL GMAIL LIMITS STILL APPLY. Google caps a consumer account at roughly 500
// recipients/day and Workspace at roughly 2000, with shorter-window throttles
// on top, and enforces them server-side regardless of what this file says.
// Removing OUR daily cap does not grant extra capacity -- it stops us guessing
// at Google's number. When Google refuses, point 4 is what handles it.
//
// ATOMICITY: check-and-consume is a single Lua script, so N workers across N
// instances cannot collectively break the spacing rule. A read-then-write in JS
// would race, and the race only shows up under exactly the concurrency where
// the guarantee matters most.

const { getRedis, isEnabled } = require("../queue/client");

// Minimum gap between two sends from one mailbox. An explicit 0 disables
// spacing entirely (not recommended -- it is the whole pacing mechanism).
const DEFAULT_SPACING_MS = (() => {
  const raw = String(process.env.MAILBOX_MIN_SPACING_MS ?? "").trim();
  if (!raw) return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 60_000;
})();

// An OPTIONAL ceiling. Unset / "0" / "off" / "none" / "unlimited" => no cap.
// Returning null rather than Infinity keeps "no cap" a distinct, printable
// value all the way out to the API and the UI.
const optionalLimit = (key) => {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw || raw === "0" || raw === "off" || raw === "none" || raw === "unlimited") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

const DEFAULT_HOURLY = optionalLimit("MAILBOX_HOURLY_LIMIT");

// There is no DEFAULT_DAILY. See point 3 above: the daily window is counted for
// display and is never a denial reason.

const spacingCeilingPerHour = (spacingMs) =>
  spacingMs > 0 ? Math.floor(3_600_000 / spacingMs) : null;

// Say once, at startup, whether the configured hourly ceiling actually does
// anything. A limit that silently never binds is worse than no limit.
const describeConfig = () => {
  if (DEFAULT_HOURLY == null) {
    return `spacing=${DEFAULT_SPACING_MS}ms (~${spacingCeilingPerHour(DEFAULT_SPACING_MS) ?? "unlimited"}/hour per mailbox), no hourly ceiling, no daily cap`;
  }
  const ceiling = spacingCeilingPerHour(DEFAULT_SPACING_MS);
  if (ceiling != null && DEFAULT_HOURLY >= ceiling) {
    return `spacing=${DEFAULT_SPACING_MS}ms (~${ceiling}/hour per mailbox); MAILBOX_HOURLY_LIMIT=${DEFAULT_HOURLY} is INERT (spacing binds first), no daily cap`;
  }
  return `spacing=${DEFAULT_SPACING_MS}ms; MAILBOX_HOURLY_LIMIT=${DEFAULT_HOURLY} BINDS BELOW the ~${ceiling}/hour spacing allows -- a mailbox will idle for the rest of each clock hour once it hits that number. No daily cap`;
};

const dayKey = (id, now) => `mbox:${id}:d:${new Date(now).toISOString().slice(0, 10)}`;
const hourKey = (id, now) => `mbox:${id}:h:${new Date(now).toISOString().slice(0, 13)}`;
const lastKey = (id) => `mbox:${id}:last`;
const coolKey = (id) => `mbox:${id}:cooldown`;

// KEYS: day, hour, last, cooldown
// ARGV: hourlyLimit (-1 = none), minSpacingMs, nowMs, dayTtl, hourTtl
//
// Returns {1, 0, ""}                 -> consumed, go ahead
//         {0, retryAfterMs, reason}  -> denied, try again in retryAfterMs
//
// Counters and the spacing stamp advance ONLY on success, so a denial never
// burns capacity and never pushes the next allowed send further out.
const CONSUME = [
  'local hourCount = tonumber(redis.call("GET", KEYS[2]) or "0")',
  'local last      = tonumber(redis.call("GET", KEYS[3]) or "0")',
  "",
  "local hourlyLimit = tonumber(ARGV[1])",
  "local spacing     = tonumber(ARGV[2])",
  "local now         = tonumber(ARGV[3])",
  "local dayTtl      = tonumber(ARGV[4])",
  "local hourTtl     = tonumber(ARGV[5])",
  "",
  "-- 1. A restriction Google actually told us about outranks everything.",
  'local coolPt = redis.call("PTTL", KEYS[4])',
  "if coolPt and coolPt > 0 then",
  '  return {0, coolPt, "provider_cooldown"}',
  "end",
  "",
  "-- 2. Optional hourly ceiling. -1 means the operator did not set one.",
  "if hourlyLimit >= 0 and hourCount >= hourlyLimit then",
  '  return {0, hourTtl * 1000, "mailbox_hourly_limit"}',
  "end",
  "",
  "-- 3. Minimum spacing -- the 60s-per-mailbox pacing rule.",
  "if spacing > 0 and last > 0 then",
  "  local elapsed = now - last",
  "  if elapsed < spacing then",
  '    return {0, spacing - elapsed, "mailbox_spacing"}',
  "  end",
  "end",
  "",
  "-- NOTE: there is deliberately NO daily-limit check. The day counter below",
  "-- exists for reporting only; a campaign is never stopped by it.",
  "",
  'redis.call("INCR", KEYS[1])',
  'redis.call("EXPIRE", KEYS[1], dayTtl)',
  'redis.call("INCR", KEYS[2])',
  'redis.call("EXPIRE", KEYS[2], hourTtl)',
  'redis.call("SET", KEYS[3], now, "EX", 86400)',
  "",
  'return {1, 0, ""}',
].join("\n");

// Giving a slot back needs its own script. A plain DECR is WRONG here: Redis
// DECR on a missing key CREATES it at -1, with no TTL. Two ways that bites --
// the window key may already have expired (day/hour rolled over) and we would
// resurrect it as a permanent never-expiring key; and a negative count reads as
// "miles under the limit", so an hourly ceiling stops binding. Only decrement a
// key that exists and is above zero, and never create one.
const RELEASE = [
  'local n = redis.call("GET", KEYS[1])',
  'if n and tonumber(n) > 0 then redis.call("DECR", KEYS[1]) end',
  'local m = redis.call("GET", KEYS[2])',
  'if m and tonumber(m) > 0 then redis.call("DECR", KEYS[2]) end',
  "return 1",
].join("\n");

// Seconds left in the current UTC day / hour. Used both as the counter TTL (so
// keys self-expire) and as the caller's retry delay when the hour is full.
const secondsLeftInDay = (now) => {
  const d = new Date(now);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((end - now) / 1000));
};

const secondsLeftInHour = (now) => {
  const d = new Date(now);
  const end = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours() + 1
  );
  return Math.max(1, Math.ceil((end - now) / 1000));
};

// Try to consume one send slot for this mailbox.
//   -> { ok: true }
//   -> { ok: false, retryAfterMs, reason }
//
// Without Redis there is no cross-process clock to consult, so spacing CANNOT
// be guaranteed and we say so rather than pretending. In this project the
// worker does not run without Redis at all, so that branch is only reachable
// in tests.
const tryConsume = async (accountId, opts = {}) => {
  if (!isEnabled()) return { ok: true, unenforced: true };

  const redis = getRedis();
  const now = Date.now();
  const hourly = opts.hourlyLimit ?? DEFAULT_HOURLY;
  const spacing = opts.minSpacingMs ?? DEFAULT_SPACING_MS;

  try {
    const [allowed, retryAfterMs, reason] = await redis.eval(
      CONSUME,
      4,
      dayKey(accountId, now),
      hourKey(accountId, now),
      lastKey(accountId),
      coolKey(accountId),
      String(hourly == null ? -1 : hourly),
      String(spacing),
      String(now),
      String(secondsLeftInDay(now)),
      String(secondsLeftInHour(now))
    );

    if (Number(allowed) === 1) return { ok: true };
    return {
      ok: false,
      retryAfterMs: Math.max(1, Number(retryAfterMs) || 60_000),
      reason: String(reason || "mailbox_rate_limited"),
    };
  } catch (e) {
    // A Redis blip must not wedge all sending. Allow, and let Gmail's own 429
    // (which IS retryable, and now also sets a cooldown) be the backstop.
    console.warn(`[mailboxLimiter] redis error, allowing send: ${e.message}`);
    return { ok: true, degraded: true };
  }
};

// Hand a slot back when we consumed a token but did not actually send.
//
// Best effort, and deliberately does NOT rewind the spacing stamp: we took this
// mailbox's turn, and the next send waiting a further minute is the safe error.
// Rewinding would also be wrong under concurrency -- we do not know what the
// previous stamp was, so we could only CLEAR it, which would let a queued job
// fire immediately and break the one-per-minute guarantee.
const release = async (accountId) => {
  if (!isEnabled()) return;
  const now = Date.now();
  try {
    await getRedis().eval(RELEASE, 2, dayKey(accountId, now), hourKey(accountId, now));
  } catch {
    /* see above */
  }
};

// Park the WHOLE mailbox because the provider told us to.
//
// Called when Gmail returns 429, a quota error, or a 5xx with retry guidance.
// Every in-flight and future job for this mailbox then defers on the same
// clock, instead of each worker independently rediscovering the restriction.
// Honours the longest cooldown asked for, so a short transient one cannot
// shorten a long quota one.
const cooldown = async (accountId, ms, reason = "provider_restriction") => {
  const duration = Math.max(0, Math.floor(Number(ms) || 0));
  if (!isEnabled() || duration <= 0) return false;
  try {
    const redis = getRedis();
    const key = coolKey(accountId);
    const existing = await redis.pttl(key);
    if (existing > duration) return false; // a longer restriction already stands
    await redis.set(key, reason, "PX", duration);
    console.warn(
      `[mailboxLimiter] mailbox=${accountId} cooling down for ` +
        `${Math.round(duration / 1000)}s (${reason})`
    );
    return true;
  } catch (e) {
    console.warn(`[mailboxLimiter] could not set cooldown: ${e.message}`);
    return false;
  }
};

const clearCooldown = async (accountId) => {
  if (!isEnabled()) return;
  try {
    await getRedis().del(coolKey(accountId));
  } catch {
    /* best effort */
  }
};

// Current usage, for dashboards and debugging. `dailyLimit: null` is the honest
// answer and the UI renders it as "no app cap" -- see point 3 at the top.
const usage = async (accountId, opts = {}) => {
  if (!isEnabled()) return null;
  const now = Date.now();
  try {
    const redis = getRedis();
    const [d, h] = await redis.mget(dayKey(accountId, now), hourKey(accountId, now));
    const cooldownMs = await redis.pttl(coolKey(accountId));
    const spacingMs = opts.minSpacingMs ?? DEFAULT_SPACING_MS;
    return {
      today: Number(d) || 0,
      thisHour: Number(h) || 0,
      dailyLimit: null, // not enforced, by design
      hourlyLimit: opts.hourlyLimit ?? DEFAULT_HOURLY,
      minSpacingMs: spacingMs,
      // What this mailbox can actually do per hour under OUR pacing. The UI
      // shows this instead of a daily quota.
      perHour: spacingCeilingPerHour(spacingMs),
      cooldownMs: cooldownMs > 0 ? cooldownMs : 0,
    };
  } catch {
    return null;
  }
};

// Resolve the effective limits for an account: its own override, else the
// server default. `??` not `||` -- a per-account 0 means "no ceiling", which is
// a real choice and must not fall through to the default.
const limitsFor = (account) => ({
  hourlyLimit: account?.hourlyLimit ?? DEFAULT_HOURLY,
  minSpacingMs: account?.minSpacingMs ?? DEFAULT_SPACING_MS,
});

module.exports = {
  tryConsume,
  release,
  cooldown,
  clearCooldown,
  usage,
  limitsFor,
  describeConfig,
  spacingCeilingPerHour,
  DEFAULT_HOURLY,
  DEFAULT_SPACING_MS,
  // exported for tests
  _keys: { dayKey, hourKey, lastKey, coolKey },
};
