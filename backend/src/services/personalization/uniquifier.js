// Per-recipient email rewriting -- the "unique emails" switch.
//
// Bulk senders get flagged partly because every recipient receives
// byte-identical copy: a mailbox provider that sees the same body land in 400
// inboxes has an easy fingerprint. With uniqueEmails on, the stored template
// stops being the literal message and becomes a REFERENCE. Immediately before
// each send, an LLM rewrites it into a one-off variant for that one recipient --
// same offer, same call to action, same links, different wording.
//
// HARD REQUIREMENTS, in priority order:
//
//   1. NEVER block or fail a send. Any error, timeout, or malformed output
//      falls back to the original rendered copy. A campaign must not stall
//      because a model had a bad day.
//   2. NEVER touch links, URLs, or image sources. A rewritten tracking link or
//      a mangled unsubscribe URL is worse than a duplicate email.
//   3. NEVER invent facts -- no names, prices, dates, statistics or claims that
//      are not already in the reference copy.
//
// Variables are interpolated by the caller BEFORE we see the text, so the model
// reads real values and can weave them in naturally instead of preserving
// literal tokens.
//
// Every rejection is logged with a machine-readable reason, so "the feature
// appears to do nothing" is always diagnosable rather than mysterious.

const ai = require("./aiProvider");
const { config, num } = require("../../config/env");
const { isFullHtmlDoc } = require("./templating");

const MODEL = config.ai.rewriteModel;
const TIMEOUT_MS = num("UNIQUE_EMAIL_TIMEOUT_MS", 30_000);
const RETRIES = Number(process.env.UNIQUE_EMAIL_RETRIES ?? 2);
const BACKOFF_MS = num("UNIQUE_EMAIL_BACKOFF_MS", 2000);
const MIN_INTERVAL_MS = Number(process.env.UNIQUE_EMAIL_MIN_INTERVAL_MS ?? 1500);
const COOLDOWN_MS = num("UNIQUE_EMAIL_COOLDOWN_MS", 30_000);
const MAX_COOLDOWN_WAIT_MS = Number(process.env.UNIQUE_EMAIL_MAX_COOLDOWN_WAIT_MS ?? 8000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -- Validators --------------------------------------------------------------
// Each one exists to catch a specific way a rewrite can be worse than the
// original. Falling back to duplicate copy costs a little spam score; shipping
// a broken link, an invented statistic, or "Hi {{first_name}}" costs a lead and
// the sender's credibility.

// Pull every URL out of a body: href/src attributes and bare links alike.
const extractUrls = (s) => {
  const out = new Set();
  const str = String(s || "");
  for (const m of str.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)) out.add(m[1].trim());
  for (const m of str.matchAll(/\bhttps?:\/\/[^\s"'<>)]+/gi)) out.add(m[0].trim());
  return out;
};

const urlsPreserved = (original, rewritten) => {
  const before = extractUrls(original);
  if (!before.size) return true;
  const after = extractUrls(rewritten);
  for (const u of before) if (!after.has(u)) return false;
  return true;
};

// Email addresses get the same treatment -- a rewritten reply-to or contact
// address silently breaks the campaign.
const extractEmails = (s) => {
  const out = new Set();
  for (const m of String(s || "").matchAll(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g)) {
    out.add(m[0].toLowerCase());
  }
  return out;
};

const emailsPreserved = (original, rewritten) => {
  const before = extractEmails(original);
  if (!before.size) return true;
  const after = extractEmails(rewritten);
  for (const e of before) if (!after.has(e)) return false;
  return true;
};

// Guard against a model that "rewrites" by truncating to a sentence or padding
// into an essay.
const lengthSane = (original, rewritten) => {
  const a = String(original).trim().length;
  const b = String(rewritten).trim().length;
  if (!a) return true;
  return b >= a * 0.5 && b <= a * 2;
};

// A literal {{token}} in the output means the model echoed the raw template
// instead of the rendered copy -- the recipient would receive "Hi
// {{first_name}}". The caller always renders first, so any surviving token is a
// defect, never legitimate.
const UNRENDERED_TOKEN_RE = /\{\{[^}]*\}\}|\{%[^%]*%\}|\$\{[^}]*\}/;
const hasUnrenderedToken = (s) => UNRENDERED_TOKEN_RE.test(String(s || ""));

// Strip the parts where digits are structural (URLs, emails, HTML attributes)
// so number checks only look at prose.
const proseOnly = (s) =>
  String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, " ");

const numbersIn = (s) => new Set(proseOnly(s).match(/\d+/g) || []);

// Every number in the rewrite must already appear in the reference. This is the
// check that stops the model inventing a statistic, a price or a date, or
// turning "20% of revenue" into "35% of revenue" -- fabrication that is both a
// legal problem and instantly obvious to a recipient. DROPPING a number is fine
// (the model may reword "15 min" as "a quick call"); introducing one is not.
const numbersPreserved = (original, rewritten) => {
  const before = numbersIn(original);
  for (const n of numbersIn(rewritten)) if (!before.has(n)) return false;
  return true;
};

// Whole-word containment. Plain .includes() is wrong for names: "Tom" is a
// substring of "au-tom-ated", "Raj" of "trajectory", "Ann" of "planned". A
// substring match would report a DROPPED first name as preserved, silently
// letting "Hi there" through.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const containsWord = (haystack, needle) => {
  const n = String(needle).trim();
  if (!n) return false;
  return new RegExp(`(?:^|\\W)${escapeRe(n)}(?:\\W|$)`, "i").test(String(haystack));
};

// Any lead field the reference actually used -- the recipient's first name,
// their company -- must still be present. Without this the model is free to
// flatten "Hi Sarah, ...BrightSmile Dental..." into a generic "Hi there, ...your
// clinic...", which is worse copy than what the user wrote. Short values are
// skipped: a 1-2 char field matches noise.
const MIN_FIELD_LEN = 3;
const fieldValuesPreserved = (originalText, rewrittenText, fields) => {
  const before = String(originalText || "");
  const after = String(rewrittenText || "");
  const missing = [];
  for (const v of Object.values(fields || {})) {
    const val = String(v == null ? "" : v).trim();
    if (val.length < MIN_FIELD_LEN) continue;
    if (containsWord(before, val) && !containsWord(after, val)) missing.push(val.toLowerCase());
  }
  return { ok: missing.length === 0, missing };
};

// The model must not switch formats: a plain-text reference must not come back
// as HTML (it would be double-escaped downstream), and neither may come back as
// markdown, which email clients render as literal asterisks and backticks.
const HAS_HTML = /<\/?(?:br|p|div|span|a|ul|ol|li|h[1-6]|strong|em|b|i|u|table|img|hr)\b[^>]*>/i;
const HAS_MARKDOWN = /```|(?:^|\s)\*\*\S|(?:^|\n)#{1,6}\s|(?:^|\n)\s*[-*]\s+\S.*\n\s*[-*]\s+/;
const formatMatches = (original, rewritten) => {
  if (HAS_MARKDOWN.test(String(rewritten))) return false;
  return HAS_HTML.test(String(original)) === HAS_HTML.test(String(rewritten));
};

// Run every check. `reason` names the FIRST failure, so an operator can see why
// a send fell back to duplicate copy.
const validateRewrite = ({ original, next, fields }) => {
  if (!next.subject || !next.body) return { ok: false, reason: "empty_rewrite" };
  if (hasUnrenderedToken(next.body) || hasUnrenderedToken(next.subject)) {
    return { ok: false, reason: "unrendered_template_token" };
  }
  if (!urlsPreserved(original.body, next.body)) {
    return { ok: false, reason: "url_altered_or_dropped" };
  }
  if (!emailsPreserved(original.body, next.body)) {
    return { ok: false, reason: "email_address_altered" };
  }
  if (!numbersPreserved(original.body, next.body)) {
    return { ok: false, reason: "number_invented" };
  }
  if (!lengthSane(original.body, next.body)) {
    return { ok: false, reason: "length_out_of_bounds" };
  }
  if (!lengthSane(original.subject, next.subject)) {
    return { ok: false, reason: "subject_length_out_of_bounds" };
  }
  if (!formatMatches(original.body, next.body)) {
    return { ok: false, reason: "format_changed" };
  }

  const body = fieldValuesPreserved(original.body, next.body, fields);
  if (!body.ok) return { ok: false, reason: `lead_field_dropped:${body.missing.join(",")}` };

  const subj = fieldValuesPreserved(original.subject, next.subject, fields);
  if (!subj.ok) return { ok: false, reason: `subject_field_dropped:${subj.missing.join(",")}` };

  return { ok: true, reason: "" };
};

// -- Client-side rate gate ---------------------------------------------------
// Free-tier and per-project quotas are small, and nothing else throttles us:
// several campaigns sending at once would fire concurrent rewrites, trip 429,
// exhaust the retries, and fall back to duplicate copy for a whole batch --
// exactly the outcome this feature exists to prevent. Spacing call STARTS by a
// minimum interval costs a little wall-clock and buys a far higher success
// rate. Set UNIQUE_EMAIL_MIN_INTERVAL_MS=0 to disable.
let nextSlotAt = 0;
const rateGate = async () => {
  if (!MIN_INTERVAL_MS) return;
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + MIN_INTERVAL_MS;
  if (slot > now) await sleep(slot - now);
};

// -- Shared circuit breaker --------------------------------------------------
// A 429 is an ACCOUNT-WIDE condition, not a property of one recipient. Without
// a shared signal, every subsequent lead independently rediscovers the rate
// limit, burning its full retry ladder before falling back -- and those doomed
// retries consume the very quota the next lead needs. On a large campaign that
// is hours of stalling plus a self-sustaining rate limit.
//
// So: the first 429 opens the breaker for a cooldown window. While it is open,
// later leads skip the model entirely and send the reference copy immediately.
// Sending duplicate copy is the accepted failure mode here; stalling a campaign
// for hours is not. The window decays, so sending self-heals.
let cooldownUntil = 0;
const openBreaker = () => {
  cooldownUntil = Date.now() + COOLDOWN_MS;
};
const breakerWaitMs = () => Math.max(0, cooldownUntil - Date.now());

// Exponential backoff with full jitter. Jitter matters: a campaign sends in
// batches, so without it every rate-limited send retries at the same instant
// and collides again.
const backoffFor = (attempt) => Math.round(Math.random() * BACKOFF_MS * 2 ** attempt);

const SYSTEM = [
  "You rewrite a single cold outreach email so that no two recipients receive identical copy.",
  "",
  "Keep IDENTICAL in meaning: the offer, the value proposition, the call to action, the sender's identity, and the overall tone and length.",
  "Change: sentence structure, word choice, phrasing, and the order of non-essential sentences.",
  "",
  "Absolute rules:",
  "- Reproduce every URL, link, and image source EXACTLY as given. Never rewrite, shorten, re-order, or drop a link, an href, or an src.",
  "- If the reference is HTML, return HTML using the same tags and structure. If it is plain text, return plain text. Never add markdown.",
  "- Never invent facts: no names, companies, numbers, prices, dates, statistics, or claims that are not already in the reference.",
  "- Never add or remove a greeting, a signature, or an unsubscribe line.",
  "- Do not mention that the email was rewritten, personalized, or generated.",
  "- The recipient's details are given only so the copy reads naturally for them. Do not assert facts about them that you were not given.",
  "",
  'Return ONLY strict JSON, no markdown fence: {"subject": "...", "body": "..."}',
].join("\n");

// Every failure path funnels through here, so a fallback is logged exactly once
// with a machine-readable reason and callers get a consistent shape.
const fallback = (original, leadEmail, reason) => {
  console.warn(`[uniqueEmails] ${reason} for ${leadEmail} -- sending reference copy`);
  return { ...original, rewritten: false, reason };
};

// Rewrite one email for one recipient. ALWAYS returns { subject, body }; on any
// failure it returns the inputs untouched, so callers can use the result
// blindly and never need a try/catch.
const uniquifyEmail = async ({ subject, body, leadEmail, fields }) => {
  const original = { subject: String(subject || ""), body: String(body || "") };
  if (!original.body.trim()) {
    return { ...original, rewritten: false, reason: "empty_reference" };
  }

  // A designed HTML document is a document, not copy. Asking a model to reword
  // the prose while reproducing every tag, attribute and inline style
  // byte-for-byte is a bet we lose: most attempts fail validation and fall back
  // anyway, after burning a call and seconds of latency per lead -- and a
  // "successful" one can quietly restyle the design in ways none of the checks
  // above look at. Send it as authored. The SUBJECT still varies per lead via
  // {{variables}}.
  if (isFullHtmlDoc(original.body)) {
    return { ...original, rewritten: false, reason: "html_document_sent_as_authored" };
  }

  if (!ai.isConfigured()) return fallback(original, leadEmail, "ai_not_configured");

  // Give the model the lead's real column values so the rewrite reads naturally
  // for this person, without letting it invent anything beyond them.
  const leadContext = Object.entries(fields || {})
    .filter(([, v]) => v != null && String(v).trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const prompt = [
    `Recipient: ${leadEmail || "(unknown)"}`,
    leadContext
      ? `Known details about the recipient:\n${leadContext}`
      : "No extra details known about the recipient.",
    "",
    `Reference subject:\n${original.subject}`,
    "",
    `Reference body:\n${original.body}`,
  ].join("\n");

  // Breaker already open from another recipient's 429? Do not queue behind a
  // known-exhausted quota -- ship the reference copy now and keep the campaign
  // moving. A short remaining window is worth waiting out; a long one is not.
  const wait = breakerWaitMs();
  if (wait > MAX_COOLDOWN_WAIT_MS) return fallback(original, leadEmail, "rate_limited_cooldown");
  if (wait > 0) await sleep(wait);

  let parsed = null;
  let lastErr = "";

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      await rateGate();
      parsed = await ai.generateJson({
        model: MODEL,
        system: SYSTEM,
        prompt,
        // Uniqueness is the entire point -- sampling must stay on. Greedy
        // decoding on a fixed template hands back near-identical copy.
        temperature: 1.0,
        timeoutMs: TIMEOUT_MS,
      });
      break;
    } catch (e) {
      lastErr = e.message;
      // Rate limiting is account-wide: tell every other in-flight recipient.
      if (ai.isRateLimited(lastErr)) openBreaker();
      if (attempt < RETRIES && ai.isTransient(lastErr)) {
        await sleep(backoffFor(attempt));
        continue;
      }
      break;
    }
  }

  if (!parsed) return fallback(original, leadEmail, `model_error:${lastErr}`);

  const next = {
    subject: String(parsed.subject || "").trim(),
    body: String(parsed.body || "").trim(),
  };

  const verdict = validateRewrite({ original, next, fields: fields || {} });
  if (!verdict.ok) return fallback(original, leadEmail, verdict.reason);

  return { ...next, rewritten: true, reason: "" };
};

module.exports = {
  uniquifyEmail,
  // Exported for the test suite.
  extractUrls,
  extractEmails,
  urlsPreserved,
  emailsPreserved,
  lengthSane,
  hasUnrenderedToken,
  numbersPreserved,
  containsWord,
  fieldValuesPreserved,
  formatMatches,
  validateRewrite,
};
