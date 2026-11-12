export default async function handler(req, res) {
  const origin = req.headers.origin;
  const allowedOrigins = new Set([
    "https://spacearcades.github.io",
    "https://space-gules-three.vercel.app"
  ]);
  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  if (!apiKey || !model) {
    return res.status(503).json({ error: "Space AI is not configured yet. Add OPENROUTER_API_KEY and OPENROUTER_MODEL in Vercel." });
  }

  try {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length || messages.length > 12) {
      return res.status(400).json({ error: "Send between 1 and 12 messages." });
    }
    const safeMessages = messages.map((message) => {
      const role = message?.role === "assistant" ? "assistant" : "user";
      const content = typeof message?.content === "string" ? message.content.slice(0, 4000) : "";
      return { role, content };
    }).filter((message) => message.content.trim());

    if (!safeMessages.length) return res.status(400).json({ error: "Message cannot be empty." });

    const requestMessages = [
      {
        role: "system",
        content: "You are Space AI for SpaceArcades. Talk like a friendly, fun gaming buddy. Keep replies SHORT and easy to understand: usually 1–3 sentences, simple words, no long paragraphs, no formal customer-service wording, and use an emoji sometimes. Be direct and helpful. Important: the website chat can open the existing missing-thumbnail uploader when the user asks to add a thumbnail for a game. The user must still choose an image and click Save thumbnail; never claim the thumbnail is saved before that. You cannot add/remove/restore games or edit links. For other management requests, give the shortest useful instruction to use the management panel. Do not repeatedly say generic offers like \"I’m happy to help with anything else.\" "
      },
      ...safeMessages
    ];

    async function askOpenRouter(modelToUse) {
      const result = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://spacearcades.github.io/SpaceA/",
          "X-OpenRouter-Title": "SpaceArcades"
        },
        body: JSON.stringify({
          model: modelToUse,
          messages: requestMessages,
          temperature: 0.7,
          max_tokens: 250
        })
      });
      const resultData = await result.json().catch(() => ({}));
      return { response: result, data: resultData };
    }

    let { response, data } = await askOpenRouter(model);
    let modelUsed = model;

    // If the selected free provider is busy or rate-limited, let OpenRouter
    // choose another available free chat model automatically.
    if ((response.status === 429 || response.status >= 500) && model !== "openrouter/free") {
      console.warn("Primary OpenRouter model unavailable; trying free-model routing.", response.status);
      const fallback = await askOpenRouter("openrouter/free");
      response = fallback.response;
      data = fallback.data;
      modelUsed = "openrouter/free";
    }

    if (!response.ok) {
      const rawError = data?.error;
      const providerMessage = String(
        (typeof rawError === "string" ? rawError : rawError?.message) ||
        data?.message ||
        "No explanation was returned."
      )
        .replace(/Bearer\\s+\\S+/gi, "Bearer [hidden]")
        .replace(/sk-or-v1-[a-zA-Z0-9_-]+/g, "[hidden key]")
        .slice(0, 500);
      console.error("OpenRouter error:", response.status, providerMessage);
      return res.status(502).json({
        error: "OpenRouter returned an error.",
        providerStatus: response.status,
        providerMessage,
        modelTried: modelUsed
      });
    }
    const readReply = (payload) => {
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content === "string") return content.trim();
      if (Array.isArray(content)) {
        return content.map(part => typeof part === "string" ? part : part?.text || "").join("").trim();
      }
      return "";
    };
    let reply = readReply(data);
    if (!reply && modelUsed !== "openrouter/free") {
      const retry = await askOpenRouter("openrouter/free");
      if (retry.response.ok) {
        const retryReply = readReply(retry.data);
        if (retryReply) reply = retryReply;
      }
    }
    if (!reply) {
      return res.status(502).json({ error: "The AI returned an empty response. Please send that again." });
    }
    return res.status(200).json({ reply });
  } catch (error) {
    console.error("Space AI request failed:", error);
    return res.status(500).json({ error: "Space AI had a server error. Please try again." });
  }
}
