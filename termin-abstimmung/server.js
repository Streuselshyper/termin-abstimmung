const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = path.join(__dirname, "data", "terminabstimmung.db");
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60 * 1000;
const VALID_STATUSES = new Set(["yes", "maybe", "no"]);
const VALID_POLL_MODES = new Set(["fixed", "free"]);
const SCORE_MAP = { yes: 2, maybe: 1, no: 0 };
const loginAttempts = new Map();

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    verification_token TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

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

  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
`);

ensureColumn("polls", "mode", "TEXT NOT NULL DEFAULT 'fixed'");
ensureColumn("polls", "user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL");
ensureColumn("responses", "suggested_dates", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("responses", "free_text_availabilities", "TEXT NOT NULL DEFAULT '[]'");
dropColumnIfExists("polls", "time_range_text");
db.exec("CREATE INDEX IF NOT EXISTS idx_polls_user_id ON polls(user_id)");

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieMiddleware);
app.use(csrfCookieMiddleware);
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));

function normalizeText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function normalizeEmail(value) {
  return normalizeText(value, 320).toLowerCase();
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

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    return { ok: false, message: "Das Passwort muss mindestens 8 Zeichen lang sein." };
  }

  return { ok: true, value: password.slice(0, 200) };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function mapUserRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    verified: Boolean(row.verified),
    createdAt: row.created_at,
  };
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
    userId: row.user_id ?? null,
    shareUrl: `/poll/${row.id}`,
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

function parseCookies(headerValue) {
  const cookies = {};
  if (!headerValue) {
    return cookies;
  }

  for (const chunk of headerValue.split(";")) {
    const index = chunk.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  return parts.join("; ");
}

function appendCookie(res, cookieValue) {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }

  const next = Array.isArray(current) ? current.concat(cookieValue) : [current, cookieValue];
  res.setHeader("Set-Cookie", next);
}

function isSecureRequest(req) {
  return req.secure || req.get("x-forwarded-proto") === "https";
}

function getCookieSettings(req, httpOnly = true) {
  return {
    httpOnly,
    sameSite: "Strict",
    secure: isSecureRequest(req),
    path: "/",
  };
}

function clearCookie(res, name, req, httpOnly = true) {
  appendCookie(
    res,
    serializeCookie(name, "", {
      ...getCookieSettings(req, httpOnly),
      maxAge: 0,
    })
  );
}

function createToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function cleanupLoginAttempts(now) {
  for (const [key, values] of loginAttempts.entries()) {
    const nextValues = values.filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS);
    if (nextValues.length === 0) {
      loginAttempts.delete(key);
    } else {
      loginAttempts.set(key, nextValues);
    }
  }
}

function recordFailedLogin(key) {
  const now = Date.now();
  cleanupLoginAttempts(now);
  const current = loginAttempts.get(key) || [];
  current.push(now);
  loginAttempts.set(key, current);
}

function clearFailedLogins(key) {
  loginAttempts.delete(key);
}

function isRateLimited(key) {
  const now = Date.now();
  cleanupLoginAttempts(now);
  const current = loginAttempts.get(key) || [];
  return current.length >= LOGIN_LIMIT;
}

function createSession(res, req, userId) {
  const sessionId = createToken(32);
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, created_at, last_activity_at) VALUES (?, ?, ?, ?)").run(
    sessionId,
    userId,
    timestamp,
    timestamp
  );
  appendCookie(
    res,
    serializeCookie(
      "session_id",
      sessionId,
      {
        ...getCookieSettings(req, true),
        maxAge: Math.floor(SESSION_TIMEOUT_MS / 1000),
      }
    )
  );
}

function destroySession(res, req) {
  const sessionId = req.cookies.session_id;
  if (sessionId) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }
  clearCookie(res, "session_id", req, true);
}

function cookieMiddleware(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  next();
}

function csrfCookieMiddleware(req, res, next) {
  const existingToken = req.cookies.csrf_token;
  if (existingToken) {
    req.csrfToken = existingToken;
    return next();
  }

  const csrfToken = createToken(24);
  req.csrfToken = csrfToken;
  appendCookie(
    res,
    serializeCookie(
      "csrf_token",
      csrfToken,
      {
        ...getCookieSettings(req, false),
        maxAge: 7 * 24 * 60 * 60,
      }
    )
  );
  next();
}

function sessionMiddleware(req, res, next) {
  req.currentUser = null;
  req.session = null;

  const sessionId = req.cookies.session_id;
  if (!sessionId) {
    return next();
  }

  const row = db
    .prepare(`
      SELECT sessions.id, sessions.user_id, sessions.created_at, sessions.last_activity_at, users.email, users.verified
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ?
    `)
    .get(sessionId);

  if (!row) {
    clearCookie(res, "session_id", req, true);
    return next();
  }

  const lastActivity = new Date(row.last_activity_at).getTime();
  if (!lastActivity || Date.now() - lastActivity > SESSION_TIMEOUT_MS) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    clearCookie(res, "session_id", req, true);
    return next();
  }

  const nowIso = new Date().toISOString();
  db.prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?").run(nowIso, sessionId);
  appendCookie(
    res,
    serializeCookie(
      "session_id",
      sessionId,
      {
        ...getCookieSettings(req, true),
        maxAge: Math.floor(SESSION_TIMEOUT_MS / 1000),
      }
    )
  );

  req.session = {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    lastActivityAt: nowIso,
  };
  req.currentUser = {
    id: row.user_id,
    email: row.email,
    verified: Boolean(row.verified),
  };

  next();
}

function requireCsrf(req, res, next) {
  const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (!unsafeMethod) {
    return next();
  }

  const headerToken = req.get("x-csrf-token");
  const cookieToken = req.cookies.csrf_token;

  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return res.status(403).json({ error: "CSRF-Prüfung fehlgeschlagen." });
  }

  next();
}

function requireAuth(req, res, next) {
  if (!req.currentUser) {
    return res.status(401).json({ error: "Bitte zuerst einloggen." });
  }

  next();
}

function getBaseUrl(req) {
  const protocol = isSecureRequest(req) ? "https" : "http";
  return `${protocol}://${req.get("host")}`;
}

function buildVerificationMailHtml({ verificationUrl, email }) {
  return `
    <div style="font-family:Arial,sans-serif;background:#f4f8fb;padding:32px 16px;color:#0f172a;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:24px;padding:32px;border:1px solid #dbe6f0;">
        <p style="margin:0 0 12px;color:#0f766e;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:12px;">Termin-Abstimmung</p>
        <h1 style="margin:0 0 16px;font-size:30px;line-height:1.1;">E-Mail-Adresse bestaetigen</h1>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Hallo, fuer <strong>${email}</strong> wurde ein Zugang zur Termin-Abstimmung angelegt.</p>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">Bitte bestaetige jetzt deine Adresse und vergebe danach dein Passwort.</p>
        <a href="${verificationUrl}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:999px;font-weight:700;">Jetzt bestaetigen</a>
        <p style="margin:24px 0 0;color:#475569;font-size:14px;line-height:1.6;">Falls der Button nicht funktioniert, oeffne diesen Link im Browser:<br /><span style="word-break:break-all;">${verificationUrl}</span></p>
      </div>
    </div>
  `;
}

async function sendVerificationEmail({ to, verificationUrl }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDGRID_FROM_EMAIL;

  if (!apiKey || !fromEmail) {
    return { delivered: false, reason: "SendGrid ist nicht konfiguriert." };
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromEmail, name: "Termin-Abstimmung" },
      subject: "Bitte bestaetige deine E-Mail-Adresse",
      content: [
        {
          type: "text/html",
          value: buildVerificationMailHtml({ verificationUrl, email: to }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SendGrid-Fehler (${response.status}): ${body.slice(0, 200)}`);
  }

  return { delivered: true };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  res.json({
    user: req.currentUser
      ? {
          id: req.currentUser.id,
          email: req.currentUser.email,
          verified: req.currentUser.verified,
        }
      : null,
    csrfToken: req.csrfToken,
    sessionTimeoutMinutes: 30,
  });
});

app.post("/api/auth/register", requireCsrf, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Bitte gib eine gueltige E-Mail-Adresse ein." });
    }

    const createdAt = new Date().toISOString();
    const verificationToken = createToken(24);
    const existingUser = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

    if (existingUser?.password_hash) {
      return res.status(409).json({ error: "Fuer diese E-Mail existiert bereits ein Konto." });
    }

    if (existingUser) {
      db.prepare(
        "UPDATE users SET verified = 0, verification_token = ?, created_at = COALESCE(created_at, ?) WHERE id = ?"
      ).run(verificationToken, createdAt, existingUser.id);
    } else {
      db.prepare(
        "INSERT INTO users (email, password_hash, verified, verification_token, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(email, null, 0, verificationToken, createdAt);
    }

    const verificationUrl = `${getBaseUrl(req)}/verify/${verificationToken}`;
    let delivery = { delivered: false, reason: "Noch nicht versucht." };

    try {
      delivery = await sendVerificationEmail({ to: email, verificationUrl });
    } catch (error) {
      delivery = { delivered: false, reason: error.message };
      console.warn("Verifizierungs-Mail konnte nicht versendet werden:", error.message);
    }

    return res.status(201).json({
      message: delivery.delivered
        ? "Registrierung gespeichert. Bitte pruefe dein E-Mail-Postfach."
        : "Registrierung gespeichert. SendGrid war nicht verfuegbar, der Verifizierungslink wurde nur intern erzeugt.",
      verificationRequired: true,
      emailDelivery: delivery.delivered ? "sendgrid" : "database",
      verificationUrl: delivery.delivered ? null : verificationUrl,
    });
  } catch (error) {
    console.error("Fehler bei der Registrierung:", error);
    return res.status(500).json({ error: "Die Registrierung konnte nicht gespeichert werden." });
  }
});

app.get("/api/auth/verify/:token", (req, res) => {
  try {
    const token = normalizeText(req.params.token, 128);
    const user = db.prepare("SELECT * FROM users WHERE verification_token = ?").get(token);

    if (!user) {
      return res.status(404).json({ error: "Der Verifizierungslink ist ungueltig oder abgelaufen." });
    }

    if (!user.verified) {
      db.prepare("UPDATE users SET verified = 1 WHERE id = ?").run(user.id);
    }

    return res.json({
      message: "E-Mail-Adresse bestaetigt. Du kannst jetzt dein Passwort setzen.",
      email: user.email,
      token,
      verified: true,
      hasPassword: Boolean(user.password_hash),
    });
  } catch (error) {
    console.error("Fehler bei der Verifizierung:", error);
    return res.status(500).json({ error: "Die Verifizierung konnte nicht abgeschlossen werden." });
  }
});

app.post("/api/auth/set-password", requireCsrf, (req, res) => {
  try {
    const token = normalizeText(req.body?.token, 128);
    const passwordCheck = validatePassword(req.body?.password);

    if (!token) {
      return res.status(400).json({ error: "Es fehlt ein gueltiger Token." });
    }

    if (!passwordCheck.ok) {
      return res.status(400).json({ error: passwordCheck.message });
    }

    const user = db.prepare("SELECT * FROM users WHERE verification_token = ?").get(token);
    if (!user) {
      return res.status(404).json({ error: "Der Link zum Passwort-Setzen ist ungueltig." });
    }

    if (!user.verified) {
      return res.status(400).json({ error: "Bitte bestaetige zuerst deine E-Mail-Adresse." });
    }

    const passwordHash = bcrypt.hashSync(passwordCheck.value, 12);
    db.prepare("UPDATE users SET password_hash = ?, verification_token = NULL WHERE id = ?").run(
      passwordHash,
      user.id
    );

    return res.json({ message: "Passwort gespeichert. Du kannst dich jetzt einloggen." });
  } catch (error) {
    console.error("Fehler beim Passwort-Setzen:", error);
    return res.status(500).json({ error: "Das Passwort konnte nicht gesetzt werden." });
  }
});

app.post("/api/auth/login", requireCsrf, (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const rateLimitKey = `${req.ip}:${email}`;

    if (isRateLimited(rateLimitKey)) {
      return res.status(429).json({ error: "Zu viele Login-Versuche. Bitte warte kurz." });
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
      recordFailedLogin(rateLimitKey);
      return res.status(401).json({ error: "E-Mail oder Passwort ist falsch." });
    }

    if (!user.verified) {
      return res.status(403).json({ error: "Bitte bestaetige zuerst deine E-Mail-Adresse." });
    }

    clearFailedLogins(rateLimitKey);
    destroySession(res, req);
    createSession(res, req, user.id);

    return res.json({
      message: "Login erfolgreich.",
      user: mapUserRow(user),
    });
  } catch (error) {
    console.error("Fehler beim Login:", error);
    return res.status(500).json({ error: "Der Login konnte nicht abgeschlossen werden." });
  }
});

app.post("/api/auth/logout", requireCsrf, (req, res) => {
  destroySession(res, req);
  res.json({ message: "Logout erfolgreich." });
});

app.get("/api/user/polls", requireAuth, (req, res) => {
  try {
    const rows = db
      .prepare("SELECT * FROM polls WHERE user_id = ? ORDER BY created_at DESC")
      .all(req.currentUser.id);

    return res.json({
      polls: rows.map(mapPollRow),
    });
  } catch (error) {
    console.error("Fehler beim Laden der User-Polls:", error);
    return res.status(500).json({ error: "Die Umfragen konnten nicht geladen werden." });
  }
});

app.post("/api/polls", requireCsrf, requireAuth, (req, res) => {
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
      return res.status(400).json({ error: "Bitte waehle mindestens ein Datum aus." });
    }

    const pollId = crypto.randomBytes(6).toString("hex");
    const createdAt = new Date().toISOString();

    db.prepare(
      "INSERT INTO polls (id, title, description, dates, mode, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(pollId, title, description, JSON.stringify(dates), mode, createdAt, req.currentUser.id);

    return res.status(201).json({
      poll: {
        id: pollId,
        title,
        description,
        dates,
        mode,
        createdAt,
        userId: req.currentUser.id,
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

app.post("/api/polls/:pollId/responses", requireCsrf, (req, res) => {
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

app.get(["/", "/login", "/register", "/dashboard", "/set-password", "/verify/:token", "/poll/:pollId"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use("/api", (req, res) => {
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
