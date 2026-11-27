import { neon } from "@neondatabase/serverless";
import { timingSafeEqual } from "node:crypto";

const EMPTY = { customGames: [], deletedGameIds: [], deletedGameTimes: {}, removedCustomGames: {}, thumbnails: {}, gameLinks: {}, gameTitles: {} };
const RESTORE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function expireRestoreEntries(state) {
  const times = state.deletedGameTimes && typeof state.deletedGameTimes === "object" ? state.deletedGameTimes : {};
  const backups = state.removedCustomGames && typeof state.removedCustomGames === "object" ? state.removedCustomGames : {};
  const ids = Array.isArray(state.deletedGameIds) ? state.deletedGameIds : [];
  const now = Date.now();
  for (const id of ids) {
    const removedAt = Number(times[id] || 0);
    if (!removedAt || now - removedAt >= RESTORE_WINDOW_MS) {
      delete times[id];
      delete backups[id];
    }
  }
  for (const id of Object.keys(times)) if (!ids.includes(id)) delete times[id];
  state.deletedGameTimes = times;
  state.removedCustomGames = backups;
  return state;
}
const sql = () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  return neon(process.env.DATABASE_URL);
};

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function authorizationError(role, code) {
  const envName = { admin: "SPACEARCADES_ADMIN_CODE", coowner: "SPACEARCADES_COOWNER_CODE", owner: "SPACEARCADES_OWNER_CODE" }[role];
  if (!envName) return "Unknown access role";
  if (!process.env[envName]) return "Vercel is missing " + envName + ". Add it in Project Settings → Environment Variables, then redeploy.";
  if (!safeEqual(code, process.env[envName])) return "The " + role + " access code does not match the Vercel environment variable.";
  return null;
}

async function ensureTable() {
  await sql()`CREATE TABLE IF NOT EXISTS shared_state (
    id INTEGER PRIMARY KEY,
    state JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
}

async function readState() {
  await ensureTable();
  const rows = await sql()`SELECT state FROM shared_state WHERE id = 1 LIMIT 1`;
  if (!rows.length) return { initialized: false, state: EMPTY };
  const original = rows[0].state || { ...EMPTY };
  const state = expireRestoreEntries({ ...original });
  if (JSON.stringify(state) !== JSON.stringify(original)) {
    await sql()`UPDATE shared_state SET state = ${JSON.stringify(state)}::jsonb, updated_at = NOW() WHERE id = 1`;
  }
  return { initialized: true, state };
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
    const authError = authorizationError(role, code);
    if (authError) return res.status(403).json({ error: authError });
    if (!state || !Array.isArray(state.customGames) || !Array.isArray(state.deletedGameIds)) {
      return res.status(400).json({ error: "Invalid game data" });
    }

    if (role === "admin") {
      const current = await readState();
      const adminCreator = String(req.body.adminCreator || "").trim().toLowerCase();
      const mine = game => !!adminCreator && String((game && game.creator) || "").trim().toLowerCase() === adminCreator;
      const previousGames = Array.isArray(current.state.customGames) ? current.state.customGames : [];
      const previousById = new Map(previousGames.map(game => [game.id, game]));
      const incomingIds = new Set(state.customGames.map(g => g && g.id).filter(id => typeof id === "string"));
      const removedGames = previousGames.filter(game => game && typeof game.id === "string" && !incomingIds.has(game.id));

      // Admins may remove only games they added.
      if (removedGames.some(game => !mine(game))) {
        return res.status(403).json({ error: "Admins can remove only games they added." });
      }
      // Admins may edit only games they added, and new games must carry their own name.
      for (const incoming of state.customGames) {
        const previous = incoming && previousById.get(incoming.id);
        if (!previous) {
          if (!mine(incoming)) return res.status(403).json({ error: "New games must use your admin creator name." });
          continue;
        }
        const changed = ["title", "url", "image", "creator"].some(field => (incoming[field] || "") !== (previous[field] || ""));
        if (changed && !mine(previous)) {
          return res.status(403).json({ error: "Admins can edit only games they added." });
        }
      }

      state.deletedGameIds = [...new Set([
        ...(current.state.deletedGameIds || []),
        ...removedGames.map(game => game.id)
      ])];
      state.deletedGameTimes = { ...(current.state.deletedGameTimes || {}) };
      state.removedCustomGames = { ...(current.state.removedCustomGames || {}) };
      for (const game of removedGames) {
        state.deletedGameTimes[game.id] = Date.now();
        state.removedCustomGames[game.id] = game;
      }

      // Thumbnails: admins can add missing ones or change those of their own games.
      const currentThumbs = current.state.thumbnails || {};
      const ownIds = new Set(previousGames.filter(mine).map(game => game.id));
      const thumbs = { ...currentThumbs };
      for (const [key, src] of Object.entries(state.thumbnails || {})) {
        if (!(key in currentThumbs) || ownIds.has(key)) thumbs[key] = src;
      }
      state.thumbnails = thumbs;
      state.gameLinks = current.state.gameLinks || {};
      state.gameTitles = current.state.gameTitles || {};
    }

    if (JSON.stringify(state).length > 4_000_000) {
      return res.status(413).json({ error: "Data is too large. Use smaller thumbnails." });
    }
    const clean = {
      customGames: state.customGames.filter(g => g && typeof g.id === "string" && typeof g.title === "string" && typeof g.url === "string"),
      deletedGameIds: [...new Set(state.deletedGameIds.filter(id => typeof id === "string"))],
      deletedGameTimes: state.deletedGameTimes && typeof state.deletedGameTimes === "object" ? state.deletedGameTimes : {},
      removedCustomGames: state.removedCustomGames && typeof state.removedCustomGames === "object" ? state.removedCustomGames : {},
      thumbnails: state.thumbnails && typeof state.thumbnails === "object" ? state.thumbnails : {},
      gameLinks: state.gameLinks && typeof state.gameLinks === "object" ? state.gameLinks : {},
      gameTitles: state.gameTitles && typeof state.gameTitles === "object" ? state.gameTitles : {}
    };
    expireRestoreEntries(clean);
    await ensureTable();
    await sql()`
      INSERT INTO shared_state (id, state, updated_at)
      VALUES (1, ${JSON.stringify(clean)}::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE
      SET state = EXCLUDED.state, updated_at = NOW()
    `;
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("SpaceArcades database save error:", error);
    return res.status(500).json({ error: "Could not save shared data: " + (error && error.message ? error.message : "unknown error") });
  }
}
