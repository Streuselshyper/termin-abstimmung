const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = path.join(__dirname, "data", "terminabstimmung.db");
const APP_BASE_URL = normalizeConfiguredBaseUrl(process.env.APP_BASE_URL || "");
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
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
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
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

migrateUsersTable();
ensureColumn("polls", "mode", "TEXT NOT NULL DEFAULT 'fixed'");
ensureColumn("polls", "user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL");
ensureColumn("responses", "suggested_dates", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("responses", "free_text_availabilities", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("responses", "user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL");
ensureColumn("users", "name", "TEXT NOT NULL DEFAULT ''");
ensureColumn("users", "reset_token", "TEXT");
ensureColumn("users", "reset_token_expires_at", "TEXT");
dropColumnIfExists("polls", "time_range_text");
db.exec("CREATE INDEX IF NOT EXISTS idx_polls_user_id ON polls(user_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token)");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_poll_user_id ON responses(poll_id, user_id) WHERE user_id IS NOT NULL");

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

function normalizeConfiguredBaseUrl(value) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }

    return `${url.protocol}//${url.host}`;
  } catch (_error) {
    return "";
  }
}

function normalizeHostHeader(value) {
  if (typeof value !== "string") {
    return "";
  }

  const host = value.trim().toLowerCase();
  if (!host || /[\s/\\]/.test(host)) {
    return "";
  }

  const ipv4OrHostname = /^[a-z0-9.-]+(?::\d{1,5})?$/;
  const ipv6WithPort = /^\[[0-9a-f:]+\](?::\d{1,5})?$/i;
  if (!ipv4OrHostname.test(host) && !ipv6WithPort.test(host)) {
    return "";
  }

  return host;
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

function migrateUsersTable() {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  const hasName = columns.some((column) => column.name === "name");
  const hasVerified = columns.some((column) => column.name === "verified");
  const hasVerificationToken = columns.some((column) => column.name === "verification_token");

  if (!hasVerified && !hasVerificationToken) {
    return;
  }

  if (hasVerified) {
    db.exec("UPDATE users SET verified = 1 WHERE verified IS NULL OR verified != 1");
  }

  const foreignKeysEnabled = db.pragma("foreign_keys", { simple: true });
  db.pragma("foreign_keys = OFF");

  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE users_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL DEFAULT '',
          password_hash TEXT,
          created_at TEXT NOT NULL
        );

        INSERT INTO users_migrated (id, email, name, password_hash, created_at)
        SELECT id, email, ${hasName ? "COALESCE(name, '')" : "''"}, password_hash, created_at
        FROM users;

        DROP TABLE users;
        ALTER TABLE users_migrated RENAME TO users;
      `);
    });

    migrate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"}`);
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
    name: row.name || "",
    createdAt: row.created_at,
  };
}

function getBaseUrl(req) {
  if (APP_BASE_URL) {
    return APP_BASE_URL;
  }

  const protocol = isSecureRequest(req) ? "https" : "http";
  const normalizedHost = normalizeHostHeader(req.get("host") || "");
  if (normalizedHost) {
    return `${protocol}://${normalizedHost}`;
  }

  return `${protocol}://${req.hostname}`;
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
    userId: row.user_id ?? null,
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

function loadPollWithResponses(pollId, currentUser = null) {
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

  return {
    poll,
    responses,
    results,
    user: currentUser
      ? {
          id: currentUser.id,
          email: currentUser.email,
        }
      : null,
  };
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
    try {
      cookies[key] = decodeURIComponent(value);
    } catch (_error) {
      cookies[key] = value;
    }
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
      SELECT sessions.id, sessions.user_id, sessions.created_at, sessions.last_activity_at, users.email, users.name
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
    name: row.name || "",
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

function clearExpiredResetTokens() {
  db.prepare(`
    UPDATE users
    SET reset_token = NULL, reset_token_expires_at = NULL
    WHERE reset_token IS NOT NULL
      AND reset_token_expires_at IS NOT NULL
      AND reset_token_expires_at < ?
  `).run(new Date().toISOString());
}

function issuePasswordResetToken(userId) {
  const token = createToken(24);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  db.prepare("UPDATE users SET reset_token = ?, reset_token_expires_at = ? WHERE id = ?").run(token, expiresAt, userId);
  return { token, expiresAt };
}

function loadUserByResetToken(token) {
  clearExpiredResetTokens();
  return db
    .prepare(`
      SELECT *
      FROM users
      WHERE reset_token = ?
        AND reset_token_expires_at IS NOT NULL
        AND reset_token_expires_at >= ?
    `)
    .get(token, new Date().toISOString());
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
          name: req.currentUser.name || "",
        }
      : null,
    csrfToken: req.csrfToken,
    sessionTimeoutMinutes: Math.floor(SESSION_TIMEOUT_MS / 60000),
  });
});

app.post("/api/auth/register", requireCsrf, (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const passwordCheck = validatePassword(req.body?.password);

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Bitte gib eine gueltige E-Mail-Adresse ein." });
    }
    if (!passwordCheck.ok) {
      return res.status(400).json({ error: passwordCheck.message });
    }

    const createdAt = new Date().toISOString();
    const passwordHash = bcrypt.hashSync(passwordCheck.value, 12);
    const existingUser = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

    if (existingUser?.password_hash) {
      return res.status(409).json({ error: "Fuer diese E-Mail existiert bereits ein Konto." });
    }

    if (existingUser) {
      db.prepare("UPDATE users SET password_hash = ?, created_at = COALESCE(created_at, ?) WHERE id = ?").run(
        passwordHash,
        createdAt,
        existingUser.id
      );
    } else {
      db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)").run(
        email,
        passwordHash,
        createdAt
      );
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    destroySession(res, req);
    createSession(res, req, user.id);

    return res.status(201).json({
      message: "Konto erstellt. Du bist jetzt eingeloggt.",
      user: mapUserRow(user),
    });
  } catch (error) {
    console.error("Fehler bei der Registrierung:", error);
    return res.status(500).json({ error: "Die Registrierung konnte nicht gespeichert werden." });
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

app.post("/api/auth/forgot-password", requireCsrf, (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Bitte gib eine gueltige E-Mail-Adresse ein." });
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !user.password_hash) {
      return res.json({
        message: "Falls ein Konto existiert, wurde ein Reset-Link erzeugt.",
      });
    }

    const { token, expiresAt } = issuePasswordResetToken(user.id);

    return res.json({
      message: "Reset-Link erzeugt. In dieser lokalen Version wird der Link direkt angezeigt.",
      resetUrl: `${getBaseUrl(req)}/reset-password?token=${token}`,
      expiresAt,
    });
  } catch (error) {
    console.error("Fehler beim Erzeugen des Passwort-Reset-Links:", error);
    return res.status(500).json({ error: "Der Reset-Link konnte nicht erzeugt werden." });
  }
});

app.get("/api/auth/reset-password/:token", (req, res) => {
  try {
    const token = normalizeText(req.params.token, 128);
    if (!token) {
      return res.status(400).json({ error: "Es fehlt ein gueltiger Token." });
    }

    const user = loadUserByResetToken(token);
    if (!user) {
      return res.status(404).json({ error: "Der Reset-Link ist ungueltig oder abgelaufen." });
    }

    return res.json({
      email: user.email,
      expiresAt: user.reset_token_expires_at,
    });
  } catch (error) {
    console.error("Fehler beim Pruefen des Reset-Tokens:", error);
    return res.status(500).json({ error: "Der Reset-Link konnte nicht geprueft werden." });
  }
});

app.post("/api/auth/reset-password", requireCsrf, (req, res) => {
  try {
    const token = normalizeText(req.body?.token, 128);
    const passwordCheck = validatePassword(req.body?.password);

    if (!token) {
      return res.status(400).json({ error: "Es fehlt ein gueltiger Token." });
    }

    if (!passwordCheck.ok) {
      return res.status(400).json({ error: passwordCheck.message });
    }

    const user = loadUserByResetToken(token);
    if (!user) {
      return res.status(404).json({ error: "Der Reset-Link ist ungueltig oder abgelaufen." });
    }

    const passwordHash = bcrypt.hashSync(passwordCheck.value, 12);
    db.prepare("UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires_at = NULL WHERE id = ?").run(
      passwordHash,
      user.id
    );

    destroySession(res, req);
    createSession(res, req, user.id);

    return res.json({
      message: "Passwort gespeichert. Du bist jetzt eingeloggt.",
      user: mapUserRow(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)),
    });
  } catch (error) {
    console.error("Fehler beim Zuruecksetzen des Passworts:", error);
    return res.status(500).json({ error: "Das Passwort konnte nicht zurueckgesetzt werden." });
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

app.get("/api/user/profile", requireAuth, (req, res) => {
  try {
    const user = db
      .prepare("SELECT id, email, name, created_at FROM users WHERE id = ?")
      .get(req.currentUser.id);

    return res.json({
      id: user.id,
      email: user.email,
      name: user.name || "",
      createdAt: user.created_at,
    });
  } catch (error) {
    console.error("Fehler beim Laden des Profils:", error);
    return res.status(500).json({ error: "Das Profil konnte nicht geladen werden." });
  }
});

app.put("/api/user/profile", requireCsrf, requireAuth, (req, res) => {
  try {
    const name = normalizeText(req.body?.name, 120);
    if (name.length < 2) {
      return res.status(400).json({ error: "Der Name muss mindestens 2 Zeichen lang sein." });
    }

    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, req.currentUser.id);
    return res.json({ success: true, name });
  } catch (error) {
    console.error("Fehler beim Aktualisieren des Profils:", error);
    return res.status(500).json({ error: "Das Profil konnte nicht gespeichert werden." });
  }
});

app.put("/api/user/password", requireCsrf, requireAuth, (req, res) => {
  try {
    const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const newPasswordCheck = validatePassword(req.body?.newPassword);

    if (!currentPassword) {
      return res.status(400).json({ error: "Bitte gib dein aktuelles Passwort ein." });
    }

    if (!newPasswordCheck.ok) {
      return res.status(400).json({ error: newPasswordCheck.message });
    }

    const user = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.currentUser.id);
    if (!user?.password_hash || !bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(400).json({ error: "Aktuelles Passwort falsch." });
    }

    const newHash = bcrypt.hashSync(newPasswordCheck.value, 12);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, req.currentUser.id);
    return res.json({ success: true });
  } catch (error) {
    console.error("Fehler beim Aendern des Passworts:", error);
    return res.status(500).json({ error: "Das Passwort konnte nicht geaendert werden." });
  }
});

app.delete("/api/user/account", requireCsrf, requireAuth, (req, res) => {
  try {
    const userId = req.currentUser.id;
    const polls = db.prepare("SELECT id FROM polls WHERE user_id = ?").all(userId);

    const deleteAccount = db.transaction(() => {
      for (const poll of polls) {
        db.prepare("DELETE FROM responses WHERE poll_id = ?").run(poll.id);
        db.prepare("DELETE FROM polls WHERE id = ?").run(poll.id);
      }

      db.prepare("DELETE FROM responses WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    });

    deleteAccount();
    destroySession(res, req);
    return res.json({ success: true });
  } catch (error) {
    console.error("Fehler beim Loeschen des Kontos:", error);
    return res.status(500).json({ error: "Das Konto konnte nicht geloescht werden." });
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
    const data = loadPollWithResponses(req.params.pollId, req.currentUser);
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
    const data = loadPollWithResponses(req.params.pollId, req.currentUser);
    if (!data) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }

    const isLoggedIn = Boolean(req.session?.userId && req.currentUser);
    const name = isLoggedIn ? req.currentUser.email : normalizeText(req.body?.name, 80);

    if (!isLoggedIn && name.length < 2) {
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
    const serializedAvailabilities = JSON.stringify(availabilities);
    const serializedSuggestedDates = JSON.stringify(suggestedDates);

    if (isLoggedIn) {
      const existing = db
        .prepare(`
          SELECT id
          FROM responses
          WHERE poll_id = ?
            AND (user_id = ? OR lower(name) = lower(?))
          ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END, id DESC
          LIMIT 1
        `)
        .get(data.poll.id, req.session.userId, name, req.session.userId);

      if (existing) {
        db.prepare(`
          UPDATE responses
          SET name = ?, user_id = ?, availabilities = ?, suggested_dates = ?, updated_at = ?
          WHERE id = ?
        `).run(
          name,
          req.session.userId,
          serializedAvailabilities,
          serializedSuggestedDates,
          timestamp,
          existing.id
        );
      } else {
        db.prepare(`
          INSERT INTO responses (poll_id, user_id, name, availabilities, suggested_dates, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          data.poll.id,
          req.session.userId,
          name,
          serializedAvailabilities,
          serializedSuggestedDates,
          timestamp,
          timestamp
        );
      }

      return res.status(201).json(loadPollWithResponses(req.params.pollId, req.currentUser));
    }

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
      serializedAvailabilities,
      serializedSuggestedDates,
      timestamp,
      timestamp
    );

    return res.status(201).json(loadPollWithResponses(req.params.pollId, req.currentUser));
  } catch (error) {
    console.error("Fehler beim Speichern der Antwort:", error);
    return res.status(500).json({ error: "Die Antwort konnte nicht gespeichert werden." });
  }
});

app.delete("/api/polls/:pollId", requireCsrf, requireAuth, (req, res) => {
  try {
    const poll = db.prepare("SELECT user_id FROM polls WHERE id = ?").get(req.params.pollId);
    if (!poll) {
      return res.status(404).json({ error: "Nicht gefunden" });
    }
    if (poll.user_id !== req.session.userId) {
      return res.status(403).json({ error: "Nicht erlaubt" });
    }

    db.prepare("DELETE FROM responses WHERE poll_id = ?").run(req.params.pollId);
    db.prepare("DELETE FROM polls WHERE id = ?").run(req.params.pollId);
    return res.json({ success: true });
  } catch (error) {
    console.error("Fehler beim Loeschen des Polls:", error);
    return res.status(500).json({ error: "Der Poll konnte nicht geloescht werden." });
  }
});

app.get(["/", "/login", "/register", "/forgot-password", "/reset-password", "/dashboard", "/account", "/poll/:pollId"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: `Route nicht gefunden: ${req.method} ${req.originalUrl}` });
});

app.use((error, _req, res, _next) => {
  console.error("Unerwarteter Serverfehler:", error);
  res.status(500).json({ error: "Interner Serverfehler." });
});

function startServer(port = PORT, host = HOST) {
  return app.listen(port, host, () => {
    console.log(`Termin-Abstimmung läuft auf http://${host}:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, db };
