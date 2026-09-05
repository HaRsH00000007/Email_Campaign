// AI template drafting: given a short brief and a target count, draft N
// DISTINCT outbound templates that use the lead list's {{column}} tokens.
//
// The user shortlists drafts in the UI and adds the ones they like as pitch
// variants (which the sender then rotates across leads). This endpoint is FREE
// of any send quota -- drafting is not sending.

const { EmailLeadList, EmailLead, User } = require("../models");
const ai = require("../services/personalization/aiProvider");
const { config } = require("../config/env");

const MAX_TEMPLATES = 10;

// Remove any [bracketed placeholder] the model slips in ("[Your Name]",
// "[Company]"). The ONLY personalization allowed is {{tokens}}; everything else
// must be real text or omitted, because a placeholder that reaches a recipient
// is unmistakably machine-generated.
const stripBrackets = (s) =>
  String(s || "")
    .replace(/\[[^\]\n]{0,80}\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// Closings the model tends to end on. Detected so the model's own sign-off (and
// any placeholder name after it) can be replaced with the real signature --
// deterministically, never trusting the model to get it right.
const CLOSING_RE =
  /^(best|thanks|thank you|regards|kind regards|warm regards|best regards|cheers|sincerely|talk soon|looking forward|all the best)[\s,!.]*$/i;

const applySignature = (body, signature) => {
  if (!signature) return String(body || "").trim();

  let lines = String(body || "").replace(/\r/g, "").split("\n");
  const dropTrailingBlanks = () => {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  };

  dropTrailingBlanks();

  let cut = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    if (CLOSING_RE.test(lines[i].trim())) {
      cut = i;
      break;
    }
  }
  if (cut !== -1) lines = lines.slice(0, cut);
  dropTrailingBlanks();

  return `${lines.join("\n").trim()}\n\nBest,\n${signature}`;
};

const SYSTEM = [
  "You draft cold outreach emails for a sales team.",
  "",
  "Rules:",
  "- Each template must be genuinely DIFFERENT from the others: a different angle, opening and structure. Do not paraphrase one idea N times.",
  "- Short. Aim for 60-120 words of body. Cold email is read on a phone.",
  "- Personalize ONLY with the {{tokens}} you are given. Never invent a name, company, number, price, date or statistic.",
  "- Never write a bracketed placeholder such as [Your Name] or [Company]. If you do not have a fact, leave it out.",
  "- Plain text, not HTML and not markdown. Line breaks are fine.",
  "- No subject-line clickbait, no all-caps, no exclamation stacking.",
  "- Do not add an unsubscribe line; the sender handles that.",
  "",
  'Return ONLY strict JSON: {"templates":[{"subject":"...","body":"...","followupSubject":"...","followupBody":"..."}]}',
  "Include followupSubject/followupBody only when a follow-up was requested.",
].join("\n");

// POST /templates/generate
// { prompt, count?, leadListId?, withFollowup? }
const generate = async (req, res) => {
  if (!ai.isConfigured()) {
    return res.status(400).json({
      message:
        "AI template drafting needs an API key. Set GEMINI_API_KEY or OPENAI_API_KEY " +
        "in the backend .env, or write templates by hand.",
    });
  }

  const brief = String(req.body?.prompt || "").trim();
  if (!brief) return res.status(400).json({ message: "Describe the email you want" });

  const count = Math.min(MAX_TEMPLATES, Math.max(1, Math.floor(Number(req.body?.count) || 3)));
  const withFollowup = !!req.body?.withFollowup;

  // Offer the real column names, plus a couple of sample values, so the model
  // writes tokens that actually resolve rather than inventing plausible ones.
  let columns = [];
  let sample = null;
  if (req.body?.leadListId) {
    const ll = await EmailLeadList.findOne({
      _id: req.body.leadListId,
      userId: req.user.id,
    })
      .select("columns")
      .lean();
    if (ll) {
      columns = ll.columns || [];
      const lead = await EmailLead.findOne({ listId: req.body.leadListId })
        .select("fields")
        .sort({ idx: 1 })
        .lean();
      if (lead?.fields) sample = lead.fields;
    }
  }

  const user = await User.findById(req.user.id).select("name signature").lean();
  const signature = user?.signature || user?.name || "";

  const prompt = [
    `Write ${count} distinct cold outreach email template(s).`,
    "",
    `Brief: ${brief}`,
    "",
    columns.length
      ? `Available personalization tokens (use them as {{Token}}): ${columns.join(", ")}`
      : "No personalization tokens are available. Write copy that reads naturally without them.",
    sample ? `Example values for one recipient: ${JSON.stringify(sample)}` : "",
    "",
    withFollowup
      ? "Also write a short follow-up for each, to send if there is no reply. It must reference the first email without repeating it."
      : "Do not write follow-ups.",
    signature ? `Sign off as: ${signature}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const parsed = await ai.generateJson({
      model: config.ai.templateModel,
      system: SYSTEM,
      prompt,
      temperature: 0.9,
      timeoutMs: 60_000,
    });

    const raw = Array.isArray(parsed) ? parsed : parsed?.templates;
    if (!Array.isArray(raw) || !raw.length) {
      return res.status(502).json({ message: "The model returned nothing usable. Try again." });
    }

    const templates = raw
      .slice(0, count)
      .map((t) => ({
        subject: stripBrackets(t?.subject || ""),
        html: applySignature(stripBrackets(t?.body ?? t?.html ?? ""), signature),
        followupSubject: stripBrackets(t?.followupSubject ?? ""),
        followupHtml: withFollowup
          ? applySignature(stripBrackets(t?.followupBody ?? t?.followupHtml ?? ""), signature)
          : "",
      }))
      .filter((t) => t.subject && t.html);

    if (!templates.length) {
      return res.status(502).json({ message: "The model returned nothing usable. Try again." });
    }

    return res.json({ ok: true, data: templates, columns });
  } catch (err) {
    const msg = err.message || "generation_failed";
    const status = ai.isRateLimited(msg) ? 429 : 502;
    return res.status(status).json({
      message: ai.isRateLimited(msg)
        ? "The AI provider is rate limiting. Wait a moment and try again."
        : `Couldn't draft templates: ${msg}`,
    });
  }
};

module.exports = { generate };
