import { neon } from "@neondatabase/serverless";
import { timingSafeEqual } from "node:crypto";

const EMPTY = { customGames: [], deletedGameIds: [], removedCustomGames: {}, thumbnails: {} };
const sql = () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  return neon(process.env.DATABASE_URL);
};

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function authorized(role, code) {
  const envName = { admin: "SPACEARCADES_ADMIN_CODE", coowner: "SPACEARCADES_COOWNER_CODE", owner: "SPACEARCADES_OWNER_CODE" }[role];
  if (!envName || !process.env[envName]) return false;
  return safeEqual(code, process.env[envName]);
}

async function readState() {
  const rows = await sql()`SELECT state FROM shared_state WHERE id = 1 LIMIT 1`;
  if (!rows.length) return { initialized: false, state: EMPTY };
  return { initialized: true, state: rows[0].state };
}

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    try { return res.status(200).json(await readState()); }
    catch (error) {
      console.error("SpaceArcades database read error:", error);
      return res.status(500).json({ error: "Shared database unavailable" });
    }
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { action, role, code, state } = req.body || {};
    if (action !== "save") return res.status(400).json({ error: "Unknown action" });
    if (!authorized(role, code)) return res.status(403).json({ error: "Invalid role credentials" });
    if (!state || !Array.isArray(state.customGames) || !Array.isArray(state.deletedGameIds)) {
      return res.status(400).json({ error: "Invalid game data" });
    }

    if (role === "admin") {
      const current = await readState();
      state.deletedGameIds = current.state.deletedGameIds || [];
      state.removedCustomGames = current.state.removedCustomGames || {};
      state.thumbnails = { ...(current.state.thumbnails || {}), ...(state.thumbnails || {}) };
      const oldIds = new Set((current.state.customGames || []).map(g => g.id));
      const newIds = new Set(state.customGames.map(g => g.id));
      if ([...oldIds].some(id => !newIds.has(id))) {
        return res.status(403).json({ error: "Admins cannot remove games" });
      }
    }

    if (JSON.stringify(state).length > 4_000_000) {
      return res.status(413).json({ error: "Data is too large. Use smaller thumbnails." });
    }
    const clean = {
      customGames: state.customGames.filter(g => g && typeof g.id === "string" && typeof g.title === "string" && typeof g.url === "string"),
      deletedGameIds: [...new Set(state.deletedGameIds.filter(id => typeof id === "string"))],
      removedCustomGames: state.removedCustomGames && typeof state.removedCustomGames === "object" ? state.removedCustomGames : {},
      thumbnails: state.thumbnails && typeof state.thumbnails === "object" ? state.thumbnails : {}
    };
    await sql()`
      INSERT INTO shared_state (id, state, updated_at)
      VALUES (1, ${JSON.stringify(clean)}::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE
      SET state = EXCLUDED.state, updated_at = NOW()
    `;
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("SpaceArcades database save error:", error);
    return res.status(500).json({ error: "Could not save shared data" });
  }
}
