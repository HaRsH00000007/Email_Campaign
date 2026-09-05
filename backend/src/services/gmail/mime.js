// Gmail MIME helpers: base64url codec, RFC 2822 message builder, payload
// parsing. Shared by the sender and by every reply-reading path so outbound and
// inbound agree on how a message is shaped.

// base64url (RFC 4648 section 5). Gmail wants the raw RFC 2822 message
// url-safe and unpadded.
const b64url = (buf) =>
  Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64urlDecode = (str) =>
  Buffer.from(String(str).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

// A header value must be a single line. Stripping CR/LF is what stops a
// caller-supplied subject from injecting extra headers (or a second body).
const oneLine = (s) => String(s || "").replace(/[\r\n]+/g, " ").trim();

// A MIME header may carry only 7-bit ASCII (RFC 5322). Anything else -- an
// emoji, an accent, a curly quote, all ordinary in a subject line -- must go
// out as an RFC 2047 "encoded-word", or the recipient sees mojibake.
//
// Encoded-words are capped at 75 chars each, so a long subject is split across
// several and folded onto continuation lines. The SOURCE is chunked by code
// point, never by byte: slicing a multi-byte character in half corrupts it.
// 39 bytes/chunk -> 52 base64 chars + the 12-char =?UTF-8?B??= envelope = 64,
// which still fits the line once "Subject: " (9) is added -- the cap applies to
// the whole LINE, not just the word.
const HAS_NON_ASCII = /[^\x00-\x7F]/; // eslint-disable-line no-control-regex
const MAX_CHUNK_BYTES = 39;

const encodeHeaderValue = (value) => {
  const s = oneLine(value);
  if (!HAS_NON_ASCII.test(s)) return s;

  const chunks = [];
  let current = "";
  // for..of iterates code points, so a surrogate pair (an emoji) stays whole.
  for (const ch of s) {
    if (Buffer.byteLength(current + ch, "utf8") > MAX_CHUNK_BYTES) {
      chunks.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) chunks.push(current);

  return chunks
    .map((c) => `=?UTF-8?B?${Buffer.from(c, "utf8").toString("base64")}?=`)
    .join("\r\n "); // folding whitespace -- the parts rejoin as one value
};

// Build a MIME message.
//
// Pure HTML (html with no text counterpart) goes out as a SINGLE text/html
// part rather than a multipart -- there is then nothing for a mail client to
// mis-pick, so it is guaranteed to render as HTML.
const buildRaw = ({ from, to, cc, subject, text, html, replyTo, headers: extra }) => {
  const headers = [];
  if (from) headers.push(`From: ${oneLine(from)}`);
  headers.push(`To: ${oneLine(to)}`);
  if (cc) headers.push(`Cc: ${oneLine(cc)}`);
  if (replyTo) headers.push(`Reply-To: ${oneLine(replyTo)}`);
  headers.push(`Subject: ${encodeHeaderValue(subject)}`);
  headers.push("MIME-Version: 1.0");

  // Threading headers, when the caller has them. Gmail also threads on its own
  // threadId, but real In-Reply-To/References make the conversation hold
  // together in every other client too.
  for (const [k, v] of Object.entries(extra || {})) {
    if (v) headers.push(`${oneLine(k)}: ${oneLine(v)}`);
  }

  if (html && !text) {
    headers.push('Content-Type: text/html; charset="UTF-8"');
    return `${headers.join("\r\n")}\r\n\r\n${html}`;
  }

  if (html) {
    const boundary = `ec_${Buffer.from(String(to)).toString("hex").slice(0, 16)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body =
      `\r\n--${boundary}\r\n` +
      `Content-Type: text/plain; charset="UTF-8"\r\n\r\n${text || ""}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset="UTF-8"\r\n\r\n${html}\r\n` +
      `--${boundary}--`;
    return `${headers.join("\r\n")}\r\n${body}`;
  }

  headers.push('Content-Type: text/plain; charset="UTF-8"');
  return `${headers.join("\r\n")}\r\n\r\n${text || ""}`;
};

// Pull a header value (case-insensitive) out of a Gmail payload.
const header = (payload, name) =>
  payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

// Walk a Gmail payload tree and pull the first text/plain (falling back to
// text/html) body, decoded from base64url.
const extractBody = (payload) => {
  if (!payload) return "";
  const fromData = (part) => (part?.body?.data ? b64urlDecode(part.body.data) : "");

  if (payload.mimeType === "text/plain" && payload.body?.data) return fromData(payload);

  const parts = payload.parts || [];
  const plain = parts.find((p) => p.mimeType === "text/plain");
  if (plain?.body?.data) return fromData(plain);

  const htmlPart = parts.find((p) => p.mimeType === "text/html");
  if (htmlPart?.body?.data) return fromData(htmlPart);

  for (const p of parts) {
    const nested = extractBody(p);
    if (nested) return nested;
  }
  return payload.body?.data ? fromData(payload) : "";
};

module.exports = {
  b64url,
  b64urlDecode,
  oneLine,
  encodeHeaderValue,
  buildRaw,
  header,
  extractBody,
};
