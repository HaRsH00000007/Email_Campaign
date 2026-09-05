// The minimum a user needs to be for this product to work.
//
// ADAPTED from the reference implementation, which carried credits, a Stripe
// customer id, per-tenant provider API keys, blocked/blockedReason moderation
// flags and a large integrations sub-document. None of that is required to send
// a campaign — it existed to serve the surrounding platform. Everything below
// exists only because ownership scoping needs it: mailboxes, lists, campaigns
// and messages are all keyed by userId so two operators sharing a deployment
// cannot see or send from each other's data.

const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
      index: true,
    },
    name: { type: String, default: "", trim: true },

    // scrypt hash — see utils/password.js. select:false so a stray
    // User.find() can never leak it into an API response.
    passwordHash: { type: String, required: true, select: false },

    // Appended to AI-drafted templates so the model never has to invent a
    // signature (and never leaves a "[Your Name]" placeholder behind).
    signature: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
