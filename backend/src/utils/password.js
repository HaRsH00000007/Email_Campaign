// Password hashing with Node's built-in scrypt. No bcrypt/argon2 dependency —
// scrypt is memory-hard, in the standard library, and needs no native build.
//
// Format: "scrypt$<N>$<saltHex>$<hashHex>"

const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);
const N = 16384;
const KEYLEN = 64;

const hashPassword = async (plain) => {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(plain), salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString("hex")}$${hash.toString("hex")}`;
};

const verifyPassword = async (plain, stored) => {
  if (!stored) return false;
  const [scheme, nStr, saltHex, hashHex] = String(stored).split("$");
  if (scheme !== "scrypt") return false;
  try {
    const hash = await scrypt(String(plain), Buffer.from(saltHex, "hex"), KEYLEN, {
      N: Number(nStr),
    });
    const expected = Buffer.from(hashHex, "hex");
    // Constant-time compare; lengths must match first or timingSafeEqual throws.
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
};

module.exports = { hashPassword, verifyPassword };
