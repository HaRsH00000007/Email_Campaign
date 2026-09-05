// All API routes, mounted at /api/v1.

const express = require("express");
const multer = require("multer");

const { authenticate, asyncRoute } = require("../middleware/authenticate");

const auth = require("../controllers/auth");
const mailboxes = require("../controllers/mailboxes");
const leads = require("../controllers/leads");
const campaigns = require("../controllers/campaigns");
const thread = require("../controllers/thread");
const images = require("../controllers/images");
const aiTemplates = require("../controllers/aiTemplates");

const router = express.Router();

// Lead files are parsed in memory: they are read once and written straight to
// the database, so a temp file would only add cleanup to get wrong.
const leadUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
});

// A separate, much smaller limiter so an oversized image is rejected before it
// reaches the controller.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
});

const a = asyncRoute;

// -- Auth --------------------------------------------------------------------
router.post("/auth/signup", a(auth.signup));
router.post("/auth/login", a(auth.login));
router.get("/auth/me", authenticate, a(auth.me));
router.patch("/auth/me", authenticate, a(auth.updateMe));

// -- Mailboxes ---------------------------------------------------------------
// The OAuth callback is PUBLIC: Google redirects the user's browser to it with
// no Authorization header. Attribution comes from the signed `state` instead.
router.get("/mailboxes/oauth/callback", a(mailboxes.callback));
router.get("/mailboxes/connect", authenticate, a(mailboxes.connect));
router.get("/mailboxes", authenticate, a(mailboxes.list));
router.patch("/mailboxes/:id", authenticate, a(mailboxes.update));
router.delete("/mailboxes/:id", authenticate, a(mailboxes.remove));

// -- Lead lists --------------------------------------------------------------
// upload returns 202 and imports in the background; poll import-status.
router.post("/leads/upload", authenticate, leadUpload.single("file"), a(leads.upload));
router.get("/leads", authenticate, a(leads.list));
router.get("/leads/:id/import-status", authenticate, a(leads.importStatus));
router.get("/leads/:id", authenticate, a(leads.getOne));
router.delete("/leads/:id", authenticate, a(leads.remove));

// -- Templates ---------------------------------------------------------------
router.post("/templates/generate", authenticate, a(aiTemplates.generate));

// -- Images ------------------------------------------------------------------
// NOTE: the :slug GET is deliberately PUBLIC -- email clients fetch it directly
// and cannot send our token. The slug is 128 bits of randomness.
router.post("/images", authenticate, imageUpload.single("file"), a(images.upload));
router.get("/images", authenticate, a(images.list));
router.get("/images/:slug", a(images.serve));
router.delete("/images/:slug", authenticate, a(images.remove));

// -- Campaigns ---------------------------------------------------------------
// The two POST helpers are declared before "/:id" routes so their paths are not
// captured as an id.
router.post("/campaigns/preview-schedule", authenticate, a(campaigns.previewSchedule));
router.post("/campaigns/validate-templates", authenticate, a(campaigns.validateTemplates));

router.get("/campaigns", authenticate, a(campaigns.list));
router.post("/campaigns", authenticate, a(campaigns.create));
router.get("/campaigns/:id", authenticate, a(campaigns.getOne));
router.get("/campaigns/:id/thread", authenticate, a(thread.getThread));
router.get("/campaigns/:id/export", authenticate, a(campaigns.exportActivity));
router.patch("/campaigns/:id", authenticate, a(campaigns.update));
router.patch("/campaigns/:id/status", authenticate, a(campaigns.updateStatus));
router.post("/campaigns/:id/followup-now", authenticate, a(campaigns.followupNow));
router.post("/campaigns/:id/sync", authenticate, a(campaigns.sync));
router.delete("/campaigns/:id/recipients", authenticate, a(campaigns.removeRecipient));
router.delete("/campaigns/:id", authenticate, a(campaigns.remove));

module.exports = router;
