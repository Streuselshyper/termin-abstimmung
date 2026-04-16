const path = require("path");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = path.join(__dirname, "data", "terminabstimmung.db");
const VALID_STATUSES = new Set(["yes", "maybe", "no"]);
const VALID_POLL_MODES = new Set(["fixed", "free"]);
const SCORE_MAP = { yes: 2, maybe: 1, no: 0 };

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Initialisiert die Tabellen beim Start der Anwendung.
db.exec(`
  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    dates TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'fixed',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id TEXT NOT NULL,
    name TEXT NOT NULL,
    availabilities TEXT NOT NULL,
    suggested_dates TEXT NOT NULL DEFAULT '[]',
    free_text_availabilities TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(poll_id, name COLLATE NOCASE),
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
  );
`);

ensureColumn("polls", "mode", "TEXT NOT NULL DEFAULT 'fixed'");
ensureColumn("responses", "suggested_dates", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("responses", "free_text_availabilities", "TEXT NOT NULL DEFAULT '[]'");
dropColumnIfExists("polls", "time_range_text");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function normalizeText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function dropColumnIfExists(tableName, columnName) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((column) => column.name === columnName);
  if (!exists) {
    return;
  }

  try {
    db.exec(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`);
  } catch (error) {
    console.warn(`Spalte ${tableName}.${columnName} konnte nicht entfernt werden:`, error.message);
  }
}

function normalizeDates(dates) {
  if (!Array.isArray(dates)) {
    return [];
  }

  const uniqueDates = new Set();

  for (const date of dates) {
    if (typeof date !== "string") {
      continue;
    }

    const normalized = date.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      uniqueDates.add(normalized);
    }
  }

  return Array.from(uniqueDates).sort();
}

function normalizeMode(mode) {
  return VALID_POLL_MODES.has(mode) ? mode : "fixed";
}

function normalizeSuggestedDates(entries) {
  return normalizeDates(entries).slice(0, 60);
}

function validateAvailabilities(dates, availabilities) {
  if (!availabilities || typeof availabilities !== "object" || Array.isArray(availabilities)) {
    return { ok: false, message: "Ungültige Verfügbarkeiten." };
  }

  const normalized = {};

  for (const date of dates) {
    const status = availabilities[date];
    if (!VALID_STATUSES.has(status)) {
      return { ok: false, message: `Für ${date} fehlt ein gültiger Status.` };
    }
    normalized[date] = status;
  }

  return { ok: true, value: normalized };
}

function validateSuggestedDates(entries) {
  const normalized = normalizeSuggestedDates(entries);
  if (normalized.length === 0) {
    return { ok: false, message: "Bitte trage mindestens einen möglichen Tag ein." };
  }

  return { ok: true, value: normalized };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function mapPollRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    dates: parseJsonArray(row.dates),
    mode: normalizeMode(row.mode),
    createdAt: row.created_at,
  };
}

function mapResponseRow(row) {
  const suggestedDates = parseJsonArray(row.suggested_dates);
  const legacySuggestedDates = parseJsonArray(row.free_text_availabilities);
  return {
    id: row.id,
    pollId: row.poll_id,
    name: row.name,
    availabilities: JSON.parse(row.availabilities),
    suggestedDates: suggestedDates.length > 0 ? suggestedDates : legacySuggestedDates,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function calculateBestDates(dates, responses) {
  const summary = dates.map((date) => {
    let yes = 0;
    let maybe = 0;
    let no = 0;
    let score = 0;

    for (const response of responses) {
      const status = response.availabilities[date] || "no";
      if (status === "yes") {
        yes += 1;
      } else if (status === "maybe") {
        maybe += 1;
      } else {
        no += 1;
      }

      score += SCORE_MAP[status];
    }

    return {
      date,
      yes,
      maybe,
      no,
      score,
      participants: responses.length,
    };
  });

  const sorted = [...summary].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.yes !== left.yes) {
      return right.yes - left.yes;
    }
    return left.date.localeCompare(right.date);
  });

  const bestScore = sorted[0]?.score ?? 0;
  const bestDates = sorted.filter((entry) => entry.score === bestScore);

  return { summary, bestDates };
}

function calculateSuggestedDatesRanking(responses) {
  const counts = new Map();

  for (const response of responses) {
    for (const entry of normalizeSuggestedDates(response.suggestedDates)) {
      const current = counts.get(entry) || {
        date: entry,
        count: 0,
        participants: [],
      };

      current.count += 1;
      current.participants.push(response.name);
      counts.set(entry, current);
    }
  }

  const summary = Array.from(counts.values()).sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }
    return left.date.localeCompare(right.date, "de-DE");
  });

  const bestCount = summary[0]?.count ?? 0;
  const bestDates = summary.filter((entry) => entry.count === bestCount);

  return { summary, bestDates };
}

function loadPollWithResponses(pollId) {
  const pollRow = db.prepare("SELECT * FROM polls WHERE id = ?").get(pollId);
  if (!pollRow) {
    return null;
  }

  const responseRows = db
    .prepare("SELECT * FROM responses WHERE poll_id = ? ORDER BY updated_at DESC, id DESC")
    .all(pollId);

  const poll = mapPollRow(pollRow);
  const responses = responseRows.map(mapResponseRow);
  const results =
    poll.mode === "fixed"
      ? calculateBestDates(poll.dates, responses)
      : calculateSuggestedDatesRanking(responses);

  return { poll, responses, results };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/polls", (req, res) => {
  try {
    const title = normalizeText(req.body?.title, 120);
    const description = normalizeText(req.body?.description, 1000);
    const mode = normalizeMode(req.body?.mode);
    const dates = mode === "fixed" ? normalizeDates(req.body?.dates) : [];

    if (title.length < 3) {
      return res.status(400).json({ error: "Der Titel muss mindestens 3 Zeichen lang sein." });
    }

    if (description.length < 3) {
      return res.status(400).json({ error: "Die Beschreibung muss mindestens 3 Zeichen lang sein." });
    }

    if (mode === "fixed" && dates.length === 0) {
      return res.status(400).json({ error: "Bitte wähle mindestens ein Datum aus." });
    }

    const pollId = crypto.randomBytes(6).toString("hex");
    const createdAt = new Date().toISOString();

    db.prepare(
      "INSERT INTO polls (id, title, description, dates, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(pollId, title, description, JSON.stringify(dates), mode, createdAt);

    return res.status(201).json({
      poll: {
        id: pollId,
        title,
        description,
        dates,
        mode,
        createdAt,
        shareUrl: `/poll/${pollId}`,
      },
    });
  } catch (error) {
    console.error("Fehler beim Erstellen des Polls:", error);
    return res.status(500).json({ error: "Der Poll konnte nicht erstellt werden." });
  }
});

app.get("/api/polls/:pollId", (req, res) => {
  try {
    const data = loadPollWithResponses(req.params.pollId);
    if (!data) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }

    return res.json(data);
  } catch (error) {
    console.error("Fehler beim Laden des Polls:", error);
    return res.status(500).json({ error: "Der Poll konnte nicht geladen werden." });
  }
});

app.post("/api/polls/:pollId/responses", (req, res) => {
  try {
    const data = loadPollWithResponses(req.params.pollId);
    if (!data) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }

    const name = normalizeText(req.body?.name, 80);
    if (name.length < 2) {
      return res.status(400).json({ error: "Bitte gib einen Namen mit mindestens 2 Zeichen ein." });
    }

    let availabilities = {};
    let suggestedDates = [];

    if (data.poll.mode === "fixed") {
      const availabilityCheck = validateAvailabilities(data.poll.dates, req.body?.availabilities);
      if (!availabilityCheck.ok) {
        return res.status(400).json({ error: availabilityCheck.message });
      }
      availabilities = availabilityCheck.value;
    } else {
      const suggestedDatesCheck = validateSuggestedDates(req.body?.suggestedDates);
      if (!suggestedDatesCheck.ok) {
        return res.status(400).json({ error: suggestedDatesCheck.message });
      }
      suggestedDates = suggestedDatesCheck.value;
    }

    const timestamp = new Date().toISOString();

    db.prepare(`
      INSERT INTO responses (poll_id, name, availabilities, suggested_dates, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(poll_id, name) DO UPDATE SET
        availabilities = excluded.availabilities,
        suggested_dates = excluded.suggested_dates,
        updated_at = excluded.updated_at
    `).run(
      data.poll.id,
      name,
      JSON.stringify(availabilities),
      JSON.stringify(suggestedDates),
      timestamp,
      timestamp
    );

    return res.status(201).json(loadPollWithResponses(req.params.pollId));
  } catch (error) {
    console.error("Fehler beim Speichern der Antwort:", error);
    return res.status(500).json({ error: "Die Antwort konnte nicht gespeichert werden." });
  }
});

app.get("/poll/:pollId", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((req, res) => {
  res.status(404).json({ error: `Route nicht gefunden: ${req.method} ${req.originalUrl}` });
});

app.use((error, _req, res, _next) => {
  console.error("Unerwarteter Serverfehler:", error);
  res.status(500).json({ error: "Interner Serverfehler." });
});

function startServer(port = PORT) {
  return app.listen(port, () => {
    console.log(`Termin-Abstimmung läuft auf http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, db };
