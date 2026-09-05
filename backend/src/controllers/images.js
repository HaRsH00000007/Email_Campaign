// Template images.
//
//   POST   /images         (auth, multipart "file")  -> { url }
//   GET    /images         (auth)                    -> list
//   GET    /images/:slug   (PUBLIC -- email clients)  -> image bytes
//   DELETE /images/:slug   (auth)
//
// The :slug GET is deliberately unauthenticated: a recipient's email client
// fetches it directly and cannot send our token. The slug is 128 bits of
// randomness, so URLs are not enumerable the way sequential ids would be.

const crypto = require("crypto");
const { EmailImage } = require("../models");
const { config } = require("../config/env");

const MAX_BYTES = Number(process.env.EMAIL_IMAGE_MAX_BYTES) || 5 * 1024 * 1024;

const ALLOWED = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Swap this for a CDN base URL to move hosting off this server without touching
// anything else.
const publicUrl = (slug) => `${config.publicUrl}/api/v1/images/${slug}`;

// POST /images
const upload = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "An image file is required" });

  const ext = ALLOWED[req.file.mimetype];
  if (!ext) {
    return res.status(400).json({ message: "Unsupported image type. Use PNG, JPEG, GIF or WebP." });
  }
  if (req.file.size > MAX_BYTES) {
    return res
      .status(400)
      .json({ message: `Image is too large (max ${Math.round(MAX_BYTES / 1024 / 1024)}MB)` });
  }

  const slug = `${crypto.randomBytes(16).toString("hex")}.${ext}`;

  await EmailImage.create({
    slug,
    userId: req.user.id,
    filename: req.file.originalname || "",
    contentType: req.file.mimetype,
    size: req.file.size,
    data: req.file.buffer,
  });

  if (config.publicUrl.includes("localhost")) {
    console.warn(
      "[images] PUBLIC_URL points at localhost -- images embedded in delivered " +
        "email will not load for recipients. Set a public URL before sending."
    );
  }

  return res.status(201).json({ ok: true, data: { slug, url: publicUrl(slug) } });
};

// GET /images
const list = async (req, res) => {
  const images = await EmailImage.find({ userId: req.user.id })
    .select("slug filename contentType size createdAt")
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  return res.json({
    ok: true,
    data: images.map((i) => ({ ...i, url: publicUrl(i.slug) })),
  });
};

// GET /images/:slug  -- PUBLIC
const serve = async (req, res) => {
  const img = await EmailImage.findOne({ slug: req.params.slug }).lean();
  if (!img) return res.status(404).end();

  res.setHeader("Content-Type", img.contentType);
  res.setHeader("Content-Length", img.data.length);
  // Immutable: the slug is unique per upload, so the bytes behind a given URL
  // never change.
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  return res.end(img.data);
};

// DELETE /images/:slug
const remove = async (req, res) => {
  const deleted = await EmailImage.findOneAndDelete({
    slug: req.params.slug,
    userId: req.user.id,
  });
  if (!deleted) return res.status(404).json({ message: "Image not found" });
  return res.json({ ok: true });
};

module.exports = { upload, list, serve, remove };
