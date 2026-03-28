const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ── Storage ───────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, "data.json");

function readDB() {
  try {
    if (!fs.existsSync(DB_PATH)) return { entries: [] };
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return { entries: [] };
  }
}

function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────
function getRegion(ip) {
  return fetch(`http://ip-api.com/json/${ip}?fields=regionName,country`)
    .then(r => r.json())
    .then(d => d.regionName || d.country || null)
    .catch(() => null);
}

function getDevice(userAgent = "") {
  if (/mobile|android|iphone|ipad/i.test(userAgent)) return "mobile";
  return "desktop";
}

// ── Analyze route ─────────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt provided" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "API call failed" });
  }
});

// ── Log route ─────────────────────────────────────────────────────────────
app.post("/log", async (req, res) => {
  const { state, weightedAvg, percentile, books } = req.body;
  if (!books || !Array.isArray(books)) return res.status(400).json({ error: "No books" });

  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const device = getDevice(req.headers["user-agent"]);

  try {
    const region = await getRegion(ip);
    const db = readDB();

    db.entries.push({
      timestamp: new Date().toISOString(),
      ip,
      region: region || null,
      state: state || null,
      device,
      weightedAvg: weightedAvg || null,
      percentile: percentile || null,
      books
    });

    writeDB(db);
    res.json({ ok: true });
  } catch (err) {
    console.error("Log error:", err);
    res.status(500).json({ error: "Logging failed" });
  }
});

// ── CSV export ────────────────────────────────────────────────────────────
app.get("/export", (req, res) => {
  const password = process.env.EXPORT_PASSWORD || "readingscore";
  if (req.query.password !== password) return res.status(401).send("Unauthorized");

  const db = readDB();

  const headers = ["Timestamp", "State", "Region", "Device", "Weighted Avg Grade", "Percentile", "Title", "Author", "Book Grade", "Book Level"];

  const rows = [];
  for (const entry of db.entries) {
    if (!entry.books || entry.books.length === 0) continue;
    for (const book of entry.books) {
      rows.push([
        entry.timestamp,
        entry.state || "",
        entry.region || "",
        entry.device || "",
        entry.weightedAvg || "",
        entry.percentile || "",
        `"${(book.title || "").replace(/"/g, '""')}"`,
        `"${(book.author || "").replace(/"/g, '""')}"`,
        book.gradeLevel || "",
        book.levelLabel || ""
      ].join(","));
    }
  }

  const csv = [headers.join(","), ...rows].join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="readingscore-${Date.now()}.csv"`);
  res.send(csv);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
