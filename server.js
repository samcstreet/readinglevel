const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ── Database setup ────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, "responses.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    ip TEXT,
    region TEXT,
    state TEXT,
    device TEXT,
    avg_grade REAL,
    avg_label TEXT,
    percentile INTEGER,
    percentile_label TEXT,
    assessment TEXT
  );

  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    analysis_id INTEGER NOT NULL,
    title TEXT,
    author TEXT,
    grade_level REAL,
    level_label TEXT,
    FOREIGN KEY (analysis_id) REFERENCES analyses(id)
  );
`);

const insertAnalysis = db.prepare(`
  INSERT INTO analyses (timestamp, ip, region, state, device, avg_grade, avg_label, percentile, percentile_label, assessment)
  VALUES (@timestamp, @ip, @region, @state, @device, @avg_grade, @avg_label, @percentile, @percentile_label, @assessment)
`);

const insertBook = db.prepare(`
  INSERT INTO books (analysis_id, title, author, grade_level, level_label)
  VALUES (@analysis_id, @title, @author, @grade_level, @level_label)
`);

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
  const { prompt, state } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt provided" });

  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const device = getDevice(req.headers["user-agent"]);

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

    // Parse and log the result
    try {
      const text = data.content.map(i => i.text || "").join("\n");
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      const region = await getRegion(ip);

      const info = insertAnalysis.run({
        timestamp: new Date().toISOString(),
        ip,
        region: region || null,
        state: state || null,
        device,
        avg_grade: parsed.averageGrade,
        avg_label: parsed.averageLabel,
        percentile: parsed.percentile,
        percentile_label: parsed.percentileLabel,
        assessment: parsed.assessment
      });

      const logBooks = db.transaction((books) => {
        for (const book of books) {
          insertBook.run({
            analysis_id: info.lastInsertRowid,
            title: book.title,
            author: book.author || null,
            grade_level: book.gradeLevel,
            level_label: book.levelLabel
          });
        }
      });

      logBooks(parsed.books);
    } catch (logErr) {
      console.error("Logging error:", logErr);
    }

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "API call failed" });
  }
});

// ── CSV export (password protected) ──────────────────────────────────────
app.get("/export", (req, res) => {
  const password = process.env.EXPORT_PASSWORD || "readingscore";
  if (req.query.password !== password) {
    return res.status(401).send("Unauthorized");
  }

  const rows = db.prepare(`
    SELECT
      a.timestamp, a.state, a.region, a.device,
      a.avg_grade, a.avg_label, a.percentile, a.percentile_label,
      a.assessment,
      b.title, b.author, b.grade_level, b.level_label
    FROM analyses a
    LEFT JOIN books b ON b.analysis_id = a.id
    ORDER BY a.id DESC
  `).all();

  const headers = [
    "Timestamp", "State", "Region", "Device",
    "Avg Grade", "Avg Label", "Percentile", "Percentile Label",
    "Assessment", "Title", "Author", "Book Grade", "Book Level"
  ];

  const csv = [
    headers.join(","),
    ...rows.map(r => [
      r.timestamp, r.state || "", r.region || "", r.device || "",
      r.avg_grade, r.avg_label || "", r.percentile, r.percentile_label || "",
      `"${(r.assessment || "").replace(/"/g, '""')}"`,
      `"${(r.title || "").replace(/"/g, '""')}"`,
      `"${(r.author || "").replace(/"/g, '""')}"`,
      r.grade_level, r.level_label || ""
    ].join(","))
  ].join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="readingscore-${Date.now()}.csv"`);
  res.send(csv);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
