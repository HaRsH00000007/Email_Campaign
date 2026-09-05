// A tiny provider abstraction over the two LLMs this project can use.
//
// REIMPLEMENTED. The reference implementation reached the model three different
// ways -- a Vertex service-account client for rewriting, an OpenAI fetch call
// for template drafting, and a Gemini API-key SDK as a fallback -- which meant
// a GCP service-account JSON on disk was effectively required to get the
// rewrite feature. Here both features go through one interface backed by a
// plain API key, so setup is two env vars and nothing is written to disk.
//
// Both are OPTIONAL. With neither key set, generateJson() reports
// "not_configured" and every caller degrades cleanly -- rewriting sends the
// original copy, template drafting returns a clear error to the UI.

const { config } = require("../../config/env");

const hasGemini = () => !!config.ai.geminiKey;
const hasOpenai = () => !!config.ai.openaiKey;
const isConfigured = () => hasGemini() || hasOpenai();

// Which provider serves a given model name.
const providerFor = (model) => {
  const m = String(model || "").toLowerCase();
  if (m.startsWith("gemini")) return hasGemini() ? "gemini" : hasOpenai() ? "openai" : null;
  if (m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3")) {
    return hasOpenai() ? "openai" : hasGemini() ? "gemini" : null;
  }
  return hasGemini() ? "gemini" : hasOpenai() ? "openai" : null;
};

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms)),
  ]);

// -- Gemini ------------------------------------------------------------------
const geminiGenerate = async ({ model, system, prompt, temperature, json, timeoutMs }) => {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(config.ai.geminiKey);
  const client = genAI.getGenerativeModel({
    model,
    ...(system ? { systemInstruction: system } : {}),
    generationConfig: {
      temperature,
      ...(json ? { responseMimeType: "application/json" } : {}),
    },
  });
  const result = await withTimeout(client.generateContent(prompt), timeoutMs);
  return result?.response?.text?.() || "";
};

// -- OpenAI ------------------------------------------------------------------
const openaiGenerate = async ({ model, system, prompt, temperature, json, timeoutMs }) => {
  const res = await withTimeout(
    fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.ai.openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: prompt },
        ],
        temperature,
        ...(json ? { response_format: { type: "json_object" } } : {}),
      }),
    }),
    timeoutMs
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `openai_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data?.choices?.[0]?.message?.content || "";
};

// Generate text. Throws on failure -- callers decide whether that is fatal.
const generate = async ({
  model,
  system = "",
  prompt,
  temperature = 1.0,
  json = false,
  timeoutMs = 30_000,
}) => {
  const provider = providerFor(model);
  if (!provider) throw new Error("not_configured");

  // If the requested model does not belong to the available provider, fall back
  // to that provider's default rather than failing.
  let effectiveModel = model;
  if (provider === "gemini" && !String(model).toLowerCase().startsWith("gemini")) {
    effectiveModel = "gemini-2.5-flash";
  }
  if (provider === "openai" && String(model).toLowerCase().startsWith("gemini")) {
    effectiveModel = "gpt-4o-mini";
  }

  const args = { model: effectiveModel, system, prompt, temperature, json, timeoutMs };
  return provider === "gemini" ? geminiGenerate(args) : openaiGenerate(args);
};

// Generate and parse JSON, tolerating code fences and stray prose around it --
// models add both even when told not to.
const generateJson = async (opts) => {
  const raw = await generate({ ...opts, json: true });
  const cleaned = String(raw || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  if (!cleaned) throw new Error("empty_model_output");
  try {
    return JSON.parse(cleaned);
  } catch {
    // Salvage the outermost object or array.
    const objStart = cleaned.indexOf("{");
    const arrStart = cleaned.indexOf("[");
    const start =
      arrStart !== -1 && (objStart === -1 || arrStart < objStart) ? arrStart : objStart;
    const end =
      start === arrStart ? cleaned.lastIndexOf("]") : cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) throw new Error("unparseable_model_output");
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      throw new Error("unparseable_model_output");
    }
  }
};

// Is this failure worth retrying?
const isRateLimited = (msg) => /\b429\b|RESOURCE_EXHAUSTED|rate.?limit/i.test(String(msg));
const isTransient = (msg) =>
  isRateLimited(msg) || /\b50[0-9]\b|UNAVAILABLE|deadline|timeout|ECONN|ETIMEDOUT/i.test(String(msg));

module.exports = {
  generate,
  generateJson,
  isConfigured,
  hasGemini,
  hasOpenai,
  providerFor,
  isRateLimited,
  isTransient,
};
