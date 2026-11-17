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
        content: "You are Space AI for SpaceArcades, a friendly gaming buddy. Keep replies short (usually 1–3 sentences), clear, natural, and useful. Do not answer ordinary messages with repetitive generic laughter or canned offers. Match the user's actual request: if they say hello, greet them; if they joke, respond naturally; if they ask for a random game, invent a fun, specific game concept with a title, objective, and how to play; if they ask for help, give practical help. Do not pretend a game has been added to the website. Use an emoji sometimes, but not in every reply. The website chat can open the existing missing-thumbnail uploader when the user asks to add a thumbnail for a game. The user must still choose an image and click Save thumbnail; never claim the thumbnail is saved before that. You cannot add/remove/restore games or edit links. For other management requests, give the shortest useful instruction to use the management panel."
      },
      ...safeMessages
    ];

    const readReply = (payload) => {
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content === "string") return content.trim();
      if (Array.isArray(content)) {
        return content.map(part => typeof part === "string" ? part : part?.text || "").join("").trim();
      }
      return "";
    };

    async function askOpenRouter(modelToUse) {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
          temperature: 0.8,
          max_tokens: 350
        })
      });
      const data = await response.json().catch(() => ({}));
      return { response, data, reply: readReply(data) };
    }

    // Free models can occasionally return an empty completion or be temporarily
    // unavailable. Retry the configured model, then use OpenRouter's free router.
    const attempts = [
      { model, delay: 0 },
      { model, delay: 700 },
      { model: "openrouter/free", delay: 0 },
      { model: "openrouter/free", delay: 900 }
    ];
    let lastFailure = null;
    for (const attempt of attempts) {
      if (attempt.delay) await new Promise(resolve => setTimeout(resolve, attempt.delay));
      try {
        const result = await askOpenRouter(attempt.model);
        if (result.response.ok && result.reply) {
          return res.status(200).json({ reply: result.reply });
        }
        const rawError = result.data?.error;
        const providerMessage = String(
          (typeof rawError === "string" ? rawError : rawError?.message) ||
          result.data?.message ||
          (result.response.ok
            ? "The model returned no text" + (result.data?.choices?.[0]?.finish_reason ? " (finish reason: " + result.data.choices[0].finish_reason + ")" : "")
            : "No explanation was returned.")
        )
          .replace(/Bearer\\s+\\S+/gi, "Bearer [hidden]")
          .replace(/sk-or-v1-[a-zA-Z0-9_-]+/g, "[hidden key]")
          .slice(0, 300);
        lastFailure = {
          status: result.response.status,
          message: providerMessage,
          model: attempt.model
        };
        console.warn("Space AI attempt did not return a usable reply:", lastFailure);
        // Retry transient HTTP failures and empty completions; stop on other client errors.
        if (!result.response.ok && result.response.status < 500 && result.response.status !== 429) break;
      } catch (error) {
        lastFailure = {
          status: 0,
          message: String(error?.message || "Network request failed").slice(0, 300),
          model: attempt.model
        };
        console.warn("Space AI request attempt failed:", lastFailure);
      }
    }

    console.error("All Space AI model attempts failed:", lastFailure);
    return res.status(502).json({
      error: lastFailure?.message === "The model returned no text"
        ? "Space AI's model kept returning empty replies. Please try again in a moment."
        : "Space AI could not get a reply from its AI provider. Please try again in a moment.",
      providerStatus: lastFailure?.status || undefined,
      providerMessage: lastFailure?.message || undefined,
      modelTried: lastFailure?.model || model
    });
  } catch (error) {
    console.error("Space AI request failed:", error);
    return res.status(500).json({ error: "Space AI had a server error. Please try again." });
  }
}
