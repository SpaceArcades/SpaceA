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

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://spacearcades.github.io/SpaceA/",
        "X-OpenRouter-Title": "SpaceArcades"
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "You are Space AI, the friendly assistant for the SpaceArcades gaming website. Help visitors with games, explain features, and answer questions clearly. You cannot actually change, add, delete, restore, rename, or edit games yet. Never claim that you performed a website action. If asked to manage a game, explain that game-management actions are not connected yet and that an authorized site manager must use the management panel."
          },
          ...safeMessages
        ],
        temperature: 0.7,
        max_tokens: 700
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("OpenRouter error:", response.status, data?.error?.message || "Unknown error");
      return res.status(502).json({ error: "The AI provider could not answer. Check the model ID, API key and OpenRouter limits." });
    }
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) {
      return res.status(502).json({ error: "The AI returned an empty response. Try again." });
    }
    return res.status(200).json({ reply: reply.trim() });
  } catch (error) {
    console.error("Space AI request failed:", error);
    return res.status(500).json({ error: "Space AI had a server error. Please try again." });
  }
}
