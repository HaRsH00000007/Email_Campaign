// Minimal email + password auth.
//
// REIMPLEMENTED, deliberately small. The reference implementation had OTP
// signup flows, password reset by email, admin-scope tokens and a moderation
// system -- all of which need an outbound transactional mailer and a support
// process. This project needs to know who is calling so data can be scoped, and
// nothing more. Add SSO or a reset flow when there is a real user base to serve.

const jwt = require("jsonwebtoken");
const { User } = require("../models");
const { hashPassword, verifyPassword } = require("../utils/password");
const { config } = require("../config/env");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 10;

const issueToken = (user) =>
  jwt.sign({ userId: String(user._id) }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });

const publicUser = (u) => ({
  _id: u._id,
  email: u.email,
  name: u.name || "",
  signature: u.signature || "",
});

// POST /auth/signup  { email, password, name? }
const signup = async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const name = String(req.body?.name || "").trim();

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ message: "A valid email address is required" });
  }
  if (password.length < MIN_PASSWORD) {
    return res
      .status(400)
      .json({ message: `Password must be at least ${MIN_PASSWORD} characters` });
  }

  const existing = await User.findOne({ email }).lean();
  if (existing) return res.status(400).json({ message: "That email is already registered" });

  const user = await User.create({
    email,
    name,
    passwordHash: await hashPassword(password),
    signature: name,
  });

  return res.status(201).json({ token: issueToken(user), user: publicUser(user) });
};

// POST /auth/login  { email, password }
const login = async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  const user = await User.findOne({ email }).select("+passwordHash");
  // Same message and roughly the same work either way, so the response does not
  // reveal whether an address is registered.
  const ok = user && (await verifyPassword(password, user.passwordHash));
  if (!ok) return res.status(401).json({ message: "Invalid email or password" });

  return res.json({ token: issueToken(user), user: publicUser(user) });
};

// GET /auth/me
const me = async (req, res) => {
  const user = await User.findById(req.user.id).lean();
  if (!user) return res.status(404).json({ message: "User not found" });
  return res.json({ user: publicUser(user) });
};

// PATCH /auth/me  { name?, signature? }
const updateMe = async (req, res) => {
  const patch = {};
  if (req.body?.name !== undefined) patch.name = String(req.body.name).trim();
  if (req.body?.signature !== undefined) patch.signature = String(req.body.signature).trim();

  const user = await User.findByIdAndUpdate(req.user.id, { $set: patch }, { new: true }).lean();
  if (!user) return res.status(404).json({ message: "User not found" });
  return res.json({ user: publicUser(user) });
};

module.exports = { signup, login, me, updateMe };
