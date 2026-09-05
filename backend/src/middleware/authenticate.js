// JWT auth.
//
// REIMPLEMENTED. The reference implementation's authenticate read a
// Redis-cached identity document, rejected admin-scope tokens, and enforced a
// platform-wide moderation block -- all features of the surrounding product.
// Here it does the one thing this project needs: prove which user is calling,
// so every query can be scoped by userId.

const jwt = require("jsonwebtoken");
const { User } = require("../models");
const { config } = require("../config/env");

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const decoded = jwt.verify(authHeader.slice(7), config.jwtSecret);

    // Read through to the database rather than trusting the token's payload for
    // anything but the id: a deleted user's token must stop working immediately.
    const user = await User.findById(decoded.userId).select("_id email name signature").lean();
    if (!user) return res.status(401).json({ message: "User not found" });

    req.user = { id: String(user._id), email: user.email, name: user.name, signature: user.signature };
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
};

// Wrap an async handler so a thrown error becomes a 500 instead of an unhandled
// rejection that takes the process down.
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { authenticate, asyncRoute };
