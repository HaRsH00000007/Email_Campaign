// Images used inside campaign templates.
//
// Emails are HTML and clients load images by URL -- they cannot read local
// files or authenticate -- so campaign images must live at a PUBLIC URL. Bytes
// are stored in Mongo (durable across redeploys, unlike a container's disk) and
// served from an unauthenticated GET keyed by a 128-bit random slug. Random so
// the URLs are not enumerable the way sequential ObjectIds would be.
//
// ADAPTED: the reference implementation also supported signed direct-to-
// Cloudinary uploads. That is a CDN optimization, not a requirement, and it
// added a third-party account to the setup path. Self-hosting keeps the project
// dependency-free; swap in a CDN later by changing publicUrl() in the controller.

const mongoose = require("mongoose");

const emailImageSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, index: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    filename: { type: String, default: "" },
    contentType: { type: String, required: true },
    size: { type: Number, default: 0 },
    data: { type: Buffer, required: true },
  },
  { timestamps: true }
);

emailImageSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("EmailImage", emailImageSchema);
