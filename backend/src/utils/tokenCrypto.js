// Symmetric encryption for Google OAuth tokens at rest. AES-256-GCM with a key
// derived from TOKEN_ENC_KEY. On-disk format: "<ivHex>:<authTagHex>:<cipherHex>".
//
// Unlike the reference implementation this has NO development fallback key.
// A fallback silently produces tokens that look encrypted but are decryptable
// by anyone with the source, which is worse than an obvious failure.

const crypto = require("crypto");
const { config } = require("../config/env");

if (!config.tokenEncKey) {
  throw new Error(
    "TOKEN_ENC_KEY is not set. Generate one with:\n" +
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

const KEY = crypto.createHash("sha256").update(config.tokenEncKey).digest();

const encrypt = (plain) => {
  if (plain === undefined || plain === null || plain === "") return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
};

const decrypt = (blob) => {
  if (!blob) return "";
  const parts = String(blob).split(":");
  if (parts.length !== 3) return "";
  try {
    const [ivH, tagH, dataH] = parts;
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivH, "hex"));
    decipher.setAuthTag(Buffer.from(tagH, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataH, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return "";
  }
};

module.exports = { encrypt, decrypt };
