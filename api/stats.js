import { neon } from "@neondatabase/serverless";

const sql = () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  return neon(process.env.DATABASE_URL);
};

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

  try {
    const db = sql();
    // Idempotent setup keeps the counter independent of manual database changes.
    await db`CREATE TABLE IF NOT EXISTS site_stats (
      id INTEGER PRIMARY KEY,
      total_views BIGINT NOT NULL DEFAULT 0
    )`;
    await db`CREATE TABLE IF NOT EXISTS site_visitors (
      visitor_id TEXT PRIMARY KEY,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await db`INSERT INTO site_stats (id, total_views) VALUES (1, 0)
      ON CONFLICT (id) DO NOTHING`;

    const visitorId = String((req.body || {}).visitorId || "");
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(visitorId)) {
      return res.status(400).json({ error: "Invalid visitor ID" });
    }
    if ((req.body || {}).countView === true) {
      await db`UPDATE site_stats SET total_views = total_views + 1 WHERE id = 1`;
    }
    await db`INSERT INTO site_visitors (visitor_id, last_seen)
      VALUES (${visitorId}, NOW())
      ON CONFLICT (visitor_id) DO UPDATE SET last_seen = NOW()`;
    await db`DELETE FROM site_visitors WHERE last_seen < NOW() - INTERVAL '2 minutes'`;
    const rows = await db`SELECT
      (SELECT total_views FROM site_stats WHERE id = 1) AS total_views,
      (SELECT COUNT(*) FROM site_visitors WHERE last_seen >= NOW() - INTERVAL '2 minutes') AS online
    `;
    return res.status(200).json({
      totalViews: Number(rows[0].total_views || 0),
      online: Number(rows[0].online || 0)
    });
  } catch (error) {
    console.error("SpaceArcades stats error:", error);
    return res.status(500).json({ error: "Stats unavailable" });
  }
}
