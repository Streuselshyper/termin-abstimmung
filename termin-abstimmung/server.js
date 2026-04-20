const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const app = express();
const userApi = express.Router();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "terminabstimmung.db");
const MAIL_LOG_PATH = path.join(path.dirname(DB_PATH), "mail-outbox.log");
const APP_BASE_URL = normalizeConfiguredBaseUrl(process.env.APP_BASE_URL || "");
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const VALID_STATUSES = new Set(["yes", "maybe", "no"]);
const VALID_POLL_MODES = new Set(["fixed", "free"]);
const SCORE_MAP = { yes: 2, maybe: 1, no: 0 };
const VETO_SCORE_MAP = { yes: 3, maybe: 2, no: 0 };
const rateLimitBuckets = new Map();

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
    created_at TEXT NOT NULL,
    reset_token TEXT,
    reset_token_expires_at TEXT,
    notify_on_response INTEGER NOT NULL DEFAULT 1,
    daily_summary INTEGER NOT NULL DEFAULT 0,
    daily_summary_last_sent_at TEXT
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
    has_time_slots INTEGER NOT NULL DEFAULT 0,
    time_slots TEXT NOT NULL DEFAULT '{}',
    mode TEXT NOT NULL DEFAULT 'fixed',
    allow_time_slots INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    invite_message TEXT NOT NULL DEFAULT '',
    notification_email_enabled INTEGER NOT NULL DEFAULT 1,
    allow_email_invites INTEGER NOT NULL DEFAULT 1,
    last_response_at TEXT
  );

  CREATE TABLE IF NOT EXISTS time_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_date_id INTEGER NOT NULL,
    time TEXT NOT NULL,
    position INTEGER NOT NULL,
    FOREIGN KEY (poll_date_id) REFERENCES poll_dates(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    availabilities TEXT NOT NULL,
    slot_availabilities TEXT NOT NULL DEFAULT '{}',
    suggested_dates TEXT NOT NULL DEFAULT '[]',
    free_text_availabilities TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(poll_id, name COLLATE NOCASE),
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS poll_participants (
    poll_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    can_vote INTEGER NOT NULL DEFAULT 1,
    has_veto INTEGER NOT NULL DEFAULT 0,
    is_blocked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (poll_id, user_id),
    FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

ensureColumn("users", "name", "TEXT NOT NULL DEFAULT ''");
ensureColumn("users", "reset_token", "TEXT");
ensureColumn("users", "reset_token_expires_at", "TEXT");
ensureColumn("users", "notify_on_response", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("users", "daily_summary", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "daily_summary_last_sent_at", "TEXT");
ensureColumn("polls", "mode", "TEXT NOT NULL DEFAULT 'fixed'");
ensureColumn("polls", "has_time_slots", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("polls", "time_slots", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("polls", "allow_time_slots", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("polls", "created_at", "TEXT NOT NULL DEFAULT ''");
ensureColumn("polls", "updated_at", "TEXT NOT NULL DEFAULT ''");
ensureColumn("polls", "user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL");
ensureColumn("polls", "invite_message", "TEXT NOT NULL DEFAULT ''");
ensureColumn("polls", "notification_email_enabled", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("polls", "allow_email_invites", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("polls", "last_response_at", "TEXT");
ensureColumn("responses", "suggested_dates", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("responses", "slot_availabilities", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("responses", "free_text_availabilities", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("responses", "user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL");
ensureColumn("poll_participants", "can_vote", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("poll_participants", "has_veto", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("poll_participants", "is_blocked", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("poll_participants", "created_at", "TEXT NOT NULL DEFAULT ''");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_last_activity_at ON sessions(last_activity_at);
  CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token);
  CREATE INDEX IF NOT EXISTS idx_polls_user_created ON polls(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_polls_last_response_at ON polls(last_response_at DESC);
  CREATE INDEX IF NOT EXISTS idx_time_slots_poll_date_id ON time_slots(poll_date_id);
  CREATE INDEX IF NOT EXISTS idx_responses_poll_updated ON responses(poll_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_poll_participants_poll_id ON poll_participants(poll_id);
  CREATE INDEX IF NOT EXISTS idx_poll_participants_user_id ON poll_participants(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_poll_user_id
    ON responses(poll_id, user_id) WHERE user_id IS NOT NULL;
`);

backfillTimestamps();

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

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "string") {
    return value === "true" || value === "1";
  }
  return fallback;
}

function normalizeConfiguredBaseUrl(value) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
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
  return ipv4OrHostname.test(host) || ipv6WithPort.test(host) ? host : "";
}

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function backfillTimestamps() {
  const now = new Date().toISOString();
  db.prepare("UPDATE polls SET created_at = ? WHERE created_at IS NULL OR created_at = ''").run(now);
  db.prepare("UPDATE polls SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ''").run();
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function getScoreForStatus(status, hasVeto = false) {
  const scoreMap = hasVeto ? VETO_SCORE_MAP : SCORE_MAP;
  return scoreMap[status] ?? 0;
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

  return Array.from(uniqueDates).sort().slice(0, 90);
}

function normalizeSuggestedDateEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  const byDate = new Map();

  for (const entry of entries) {
    let date = "";
    let rawTimes = [];

    if (typeof entry === "string") {
      date = entry.trim();
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      date = normalizeText(entry.date, 10);
      rawTimes = Array.isArray(entry.times)
        ? entry.times
        : Array.isArray(entry.timeSlots)
          ? entry.timeSlots
          : [];
    } else {
      continue;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue;
    }

    if (!byDate.has(date)) {
      byDate.set(date, new Set());
    }

    const timeSet = byDate.get(date);
    for (const rawTime of rawTimes) {
      if (typeof rawTime !== "string") {
        continue;
      }

      const normalizedTime = rawTime.trim();
      if (isValidTimeValue(normalizedTime)) {
        timeSet.add(normalizedTime);
      }
    }
  }

  return Array.from(byDate.entries())
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
    .slice(0, 90)
    .map(([date, timeSet]) => ({
      date,
      times: Array.from(timeSet).sort(),
    }));
}

function normalizeMode(mode) {
  return VALID_POLL_MODES.has(mode) ? mode : "fixed";
}

function normalizeTimeSlotsByDate(dates, entries) {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return {};
  }

  const normalized = {};
  for (const date of dates) {
    const rawSlots = Array.isArray(entries[date]) ? entries[date] : [];
    const uniqueSlots = new Set();
    for (const slot of rawSlots) {
      if (typeof slot !== "string") {
        continue;
      }

      const normalizedSlot = slot.trim();
      if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalizedSlot)) {
        uniqueSlots.add(normalizedSlot);
      }
    }

    if (uniqueSlots.size > 0) {
      normalized[date] = Array.from(uniqueSlots).sort();
    }
  }

  return normalized;
}

function hasTimeSlotEntries(timeSlotsByDate) {
  return Object.values(timeSlotsByDate || {}).some((slots) => Array.isArray(slots) && slots.length > 0);
}

function normalizeInviteEmails(entries) {
  const source = Array.isArray(entries)
    ? entries
    : typeof entries === "string"
      ? entries
          .split(/[\n,;]+/)
          .map((item) => item.trim())
          .filter(Boolean)
      : [];

  const unique = new Set();
  for (const entry of source) {
    const email = normalizeEmail(entry);
    if (email && isValidEmail(email)) {
      unique.add(email);
    }
  }

  return Array.from(unique).slice(0, 30);
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    return { ok: false, message: "Das Passwort muss mindestens 8 Zeichen lang sein." };
  }

  return { ok: true, value: password.slice(0, 200) };
}

function validatePollInput(body) {
  console.log("DEBUG validatePollInput - body:", JSON.stringify(body, null, 2));
  const title = normalizeText(body?.title, 120);
  const description = normalizeText(body?.description, 1200);
  const mode = normalizeMode(body?.mode);
  const requestedTimeSlots = normalizeTimeSlotsByDate(normalizeDates(body?.dates), body?.timeSlots);
  const allowTimeSlots = mode === "fixed" && (normalizeBoolean(body?.allowTimeSlots, false) || hasTimeSlotEntries(requestedTimeSlots));
  const dates = mode === "fixed" ? normalizeDates(body?.dates) : [];
  let timeSlots = {};
  if (allowTimeSlots && body?.timeSlots && typeof body.timeSlots === "object" && !Array.isArray(body.timeSlots)) {
    for (const date of dates) {
      const slots = body.timeSlots[date];
      if (!Array.isArray(slots) || slots.length === 0) {
        continue;
      }

      const validSlots = [];
      for (const slot of slots) {
        if (typeof slot !== "string") {
          continue;
        }

        const normalizedSlot = slot.trim();
        if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalizedSlot)) {
          validSlots.push(normalizedSlot);
        }
      }

      if (validSlots.length > 0) {
        timeSlots[date] = Array.from(new Set(validSlots)).sort();
      }
    }
  }
  const inviteMessage = normalizeText(body?.inviteMessage, 500);
  const inviteEmails = normalizeInviteEmails(body?.inviteEmails);

  if (title.length < 3) {
    return { ok: false, message: "Der Titel muss mindestens 3 Zeichen lang sein." };
  }
  if (description.length < 3) {
    return { ok: false, message: "Die Beschreibung muss mindestens 3 Zeichen lang sein." };
  }
  if ((mode === "fixed" || allowTimeSlots) && dates.length === 0) {
    return { ok: false, message: "Bitte waehle mindestens ein Datum aus." };
  }
  if (dates.some((date) => Number.isNaN(new Date(`${date}T00:00:00Z`).getTime()))) {
    return { ok: false, message: "Mindestens ein Datum ist ungueltig." };
  }
  if (allowTimeSlots && Object.keys(timeSlots).length === 0) {
    return { ok: false, message: "Bitte hinterlege mindestens eine gueltige Uhrzeit." };
  }
  if (allowTimeSlots && dates.some((date) => !Array.isArray(timeSlots[date]) || timeSlots[date].length === 0)) {
    return { ok: false, message: "Bitte hinterlege fuer jeden Termin mindestens eine Uhrzeit." };
  }

  console.log("DEBUG - dates:", dates);
  console.log("DEBUG - requestedTimeSlots:", requestedTimeSlots);
  console.log("DEBUG - allowTimeSlots:", allowTimeSlots);
  console.log("DEBUG - final timeSlots:", timeSlots);

  return {
    ok: true,
    value: {
      title,
      description,
      mode,
      dates,
      allowTimeSlots,
      timeSlots,
      inviteMessage,
      inviteEmails,
      notificationEmailEnabled: normalizeBoolean(body?.notificationEmailEnabled, true),
      allowEmailInvites: normalizeBoolean(body?.allowEmailInvites, true),
      sendInvites: normalizeBoolean(body?.sendInvites, false),
    },
  };
}

function validateAvailabilities(dates, availabilities) {
  if (!availabilities || typeof availabilities !== "object" || Array.isArray(availabilities)) {
    return { ok: false, message: "Ungueltige Verfuegbarkeiten." };
  }

  const normalized = {};
  for (const date of dates) {
    const status = availabilities[date];
    if (!VALID_STATUSES.has(status)) {
      return { ok: false, message: `Fuer ${date} fehlt ein gueltiger Status.` };
    }
    normalized[date] = status;
  }

  return { ok: true, value: normalized };
}

function validateSlotAvailabilities(timeSlots, availabilities) {
  if (!availabilities || typeof availabilities !== "object" || Array.isArray(availabilities)) {
    return { ok: false, message: "Ungueltige Uhrzeit-Verfuegbarkeiten." };
  }

  const normalized = {};
  for (const [date, slots] of Object.entries(timeSlots)) {
    const dateAvailabilities = availabilities[date];
    if (!dateAvailabilities || typeof dateAvailabilities !== "object" || Array.isArray(dateAvailabilities)) {
      return { ok: false, message: `Fuer ${date} fehlen gueltige Uhrzeiten.` };
    }

    normalized[date] = {};
    for (const slot of slots) {
      const status = dateAvailabilities[slot];
      if (!VALID_STATUSES.has(status)) {
        return { ok: false, message: `Fuer ${date} ${slot} fehlt ein gueltiger Status.` };
      }
      normalized[date][slot] = status;
    }
  }

  return { ok: true, value: normalized };
}

function isValidTimeValue(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

function buildTimeSlotId(pollId, dateId, time) {
  return [pollId, dateId, time.replace(":", "-")].join("__");
}

function parseTimeSlotId(slotId) {
  if (typeof slotId !== "string") {
    return null;
  }

  const parts = slotId.split("__");
  if (parts.length !== 3) {
    return null;
  }

  const [pollId, dateId, timePart] = parts;
  const time = timePart.replace("-", ":");
  if (!pollId || !/^\d{4}-\d{2}-\d{2}$/.test(dateId) || !isValidTimeValue(time)) {
    return null;
  }

  return { pollId, dateId, time };
}

function mapTimeSlotEntry(pollId, dateId, time, position) {
  return {
    id: buildTimeSlotId(pollId, dateId, time),
    pollId,
    dateId,
    time,
    position,
  };
}

function listPollTimeSlots(poll) {
  const timeSlotsByDate = poll?.timeSlots && typeof poll.timeSlots === "object" ? poll.timeSlots : {};
  const entries = [];

  for (const dateId of Object.keys(timeSlotsByDate).sort()) {
    const slots = Array.isArray(timeSlotsByDate[dateId]) ? timeSlotsByDate[dateId] : [];
    slots.forEach((time, index) => {
      if (isValidTimeValue(time)) {
        entries.push(mapTimeSlotEntry(poll.id, dateId, time, index));
      }
    });
  }

  return entries;
}

function pollUsesTimeSlots(poll) {
  const timeSlotsByDate = poll?.timeSlots && typeof poll.timeSlots === "object" ? poll.timeSlots : {};
  return Boolean(poll?.allowTimeSlots || poll?.has_time_slots || hasTimeSlotEntries(timeSlotsByDate));
}

function setPollTimeSlots(pollId, timeSlotsByDate) {
  const now = new Date().toISOString();
  const hasTimeSlots = hasTimeSlotEntries(timeSlotsByDate);

  db.prepare(`
    UPDATE polls
    SET time_slots = ?, allow_time_slots = ?, has_time_slots = ?, updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(timeSlotsByDate),
    hasTimeSlots ? 1 : 0,
    hasTimeSlots ? 1 : 0,
    now,
    pollId
  );
}

function validateSlotResponses(poll, entries) {
  if (!Array.isArray(entries)) {
    return { ok: false, message: "Ungueltige Uhrzeit-Antworten." };
  }

  const expectedSlots = listPollTimeSlots(poll);
  const remaining = new Map(expectedSlots.map((slot) => [slot.id, slot]));
  const legacySlotIds = new Map(
    expectedSlots.map((slot) => [`${poll.id}:${slot.dateId}:${slot.time.replace(":", "-")}`, slot.id])
  );
  const normalized = {};

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, message: "Ungueltige Uhrzeit-Antworten." };
    }

    const dateId = normalizeText(entry.dateId, 10);
    const slotId = normalizeText(entry.slotId, 120);
    const availability = entry.availability;
    const canonicalSlotId = legacySlotIds.get(slotId) || slotId;
    const slot = remaining.get(canonicalSlotId);

    if (!slot || slot.dateId !== dateId) {
      return { ok: false, message: "Mindestens eine Uhrzeit-Antwort ist ungueltig." };
    }
    if (!VALID_STATUSES.has(availability)) {
      return { ok: false, message: `Fuer ${dateId} ${slot.time} fehlt ein gueltiger Status.` };
    }

    if (!normalized[dateId]) {
      normalized[dateId] = {};
    }
    normalized[dateId][slot.time] = availability;
    remaining.delete(canonicalSlotId);
  }

  if (remaining.size > 0) {
    const missingSlot = Array.from(remaining.values())[0];
    return { ok: false, message: `Fuer ${missingSlot.dateId} ${missingSlot.time} fehlt ein gueltiger Status.` };
  }

  return { ok: true, value: normalized };
}

function validateSuggestedDates(entries) {
  if (!Array.isArray(entries)) {
    return { ok: false, message: "Bitte trage mindestens einen moeglichen Tag ein." };
  }

  const byDate = new Map();
  for (const entry of entries) {
    let date = "";
    let rawTimes = [];

    if (typeof entry === "string") {
      date = entry.trim();
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      date = normalizeText(entry.date, 10);
      rawTimes = Array.isArray(entry.times)
        ? entry.times
        : Array.isArray(entry.timeSlots)
          ? entry.timeSlots
          : [];
    } else {
      return { ok: false, message: "Bitte trage mindestens einen moeglichen Tag ein." };
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, message: "Mindestens ein vorgeschlagener Tag ist ungueltig." };
    }

    if (!byDate.has(date)) {
      byDate.set(date, new Set());
    }

    const timeSet = byDate.get(date);
    for (const rawTime of rawTimes) {
      if (typeof rawTime !== "string") {
        return { ok: false, message: `Fuer ${date} ist mindestens eine Uhrzeit ungueltig.` };
      }

      const normalizedTime = rawTime.trim();
      if (!isValidTimeValue(normalizedTime)) {
        return { ok: false, message: `Fuer ${date} ist mindestens eine Uhrzeit ungueltig.` };
      }

      timeSet.add(normalizedTime);
    }
  }

  const normalized = Array.from(byDate.entries())
    .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
    .slice(0, 90)
    .map(([date, timeSet]) => ({
      date,
      times: Array.from(timeSet).sort(),
    }));

  if (normalized.length === 0) {
    return { ok: false, message: "Bitte trage mindestens einen moeglichen Tag ein." };
  }

  return { ok: true, value: normalized };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
    preferences: {
      notifyOnResponse: Boolean(row.notify_on_response),
      dailySummary: Boolean(row.daily_summary),
      dailySummaryLastSentAt: row.daily_summary_last_sent_at || null,
    },
  };
}

function isSecureRequest(req) {
  return req.secure || req.get("x-forwarded-proto") === "https";
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

function getShareUrl(req, pollId) {
  return `${getBaseUrl(req)}/poll/${pollId}`;
}

function mapPollRow(row, req) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    dates: parseJsonArray(row.dates),
    has_time_slots: Boolean(row.has_time_slots),
    timeSlots: parseJsonObject(row.time_slots),
    mode: normalizeMode(row.mode),
    allowTimeSlots: Boolean(row.allow_time_slots),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    userId: row.user_id ?? null,
    inviteMessage: row.invite_message || "",
    notificationEmailEnabled: Boolean(row.notification_email_enabled),
    allowEmailInvites: Boolean(row.allow_email_invites),
    lastResponseAt: row.last_response_at || null,
    shareUrl: `/poll/${row.id}`,
    absoluteShareUrl: req ? getShareUrl(req, row.id) : `/poll/${row.id}`,
  };
}

function mapResponseRow(row) {
  const suggestedDates = parseJsonArray(row.suggested_dates);
  const legacySuggestedDates = parseJsonArray(row.free_text_availabilities);
  const suggestedDateEntries = normalizeSuggestedDateEntries(
    suggestedDates.length > 0 ? suggestedDates : legacySuggestedDates
  );
  const displayName = normalizeText(row.user_name || row.user_email || row.name || "", 320) || "Unbekannt";
  return {
    id: row.id,
    pollId: row.poll_id,
    userId: row.user_id ?? null,
    name: displayName,
    availabilities: JSON.parse(row.availabilities),
    slotAvailabilities: parseJsonObject(row.slot_availabilities),
    suggestedDates: suggestedDateEntries.map((entry) => entry.date),
    suggestedDateEntries,
    hasVeto: Boolean(row.has_veto),
    canVote: row.can_vote === null || row.can_vote === undefined ? true : Boolean(row.can_vote),
    isBlocked: Boolean(row.is_blocked),
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
      score += getScoreForStatus(status, Boolean(response.hasVeto));
    }

    return { date, yes, maybe, no, score, participants: responses.length };
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
  return {
    summary,
    bestDates: sorted.filter((entry) => entry.score === bestScore && sorted.length > 0),
  };
}

function calculateBestDateSlots(timeSlots, responses) {
  const summary = [];

  for (const date of Object.keys(timeSlots).sort()) {
    for (const slot of Array.isArray(timeSlots[date]) ? timeSlots[date] : []) {
      let yes = 0;
      let maybe = 0;
      let no = 0;
      let score = 0;

      for (const response of responses) {
        const status = response.slotAvailabilities?.[date]?.[slot] || "no";
        if (status === "yes") {
          yes += 1;
        } else if (status === "maybe") {
          maybe += 1;
        } else {
          no += 1;
        }
        score += getScoreForStatus(status, Boolean(response.hasVeto));
      }

      summary.push({ date, slot, yes, maybe, no, score, participants: responses.length });
    }
  }

  const sorted = [...summary].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.yes !== left.yes) {
      return right.yes - left.yes;
    }
    if (left.date !== right.date) {
      return left.date.localeCompare(right.date);
    }
    return left.slot.localeCompare(right.slot);
  });

  const bestScore = sorted[0]?.score ?? 0;
  return {
    summary,
    bestDates: sorted.filter((entry) => entry.score === bestScore && sorted.length > 0),
  };
}

function calculatePollResults(poll, responses) {
  if (pollUsesTimeSlots(poll)) {
    return calculateBestDateSlots(poll.timeSlots || {}, responses);
  }

  if (poll.mode === "fixed") {
    return calculateBestDates(poll.dates, responses);
  }

  return calculateSuggestedDatesRanking(responses);
}

function formatBestDateEntry(entry) {
  if (!entry) {
    return "";
  }

  return entry.slot ? `${entry.date} ${entry.slot}` : entry.date;
}

function getDefaultParticipantRights() {
  return {
    canVote: true,
    hasVeto: false,
    isBlocked: false,
  };
}

function mapParticipantRow(row) {
  if (!row) {
    return null;
  }

  return {
    pollId: row.poll_id,
    userId: row.user_id,
    name: normalizeText(row.user_name || row.user_email || "", 320) || "Unbekannt",
    email: row.user_email || "",
    canVote: Boolean(row.can_vote),
    hasVeto: Boolean(row.has_veto),
    isBlocked: Boolean(row.is_blocked),
    createdAt: row.created_at,
    responseId: row.response_id ?? null,
    responseUpdatedAt: row.response_updated_at || null,
  };
}

function ensurePollParticipant(pollId, userId) {
  if (!pollId || !userId) {
    return null;
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO poll_participants (poll_id, user_id, can_vote, has_veto, is_blocked, created_at)
    VALUES (?, ?, 1, 0, 0, ?)
  `).run(pollId, userId, now);

  return db
    .prepare("SELECT * FROM poll_participants WHERE poll_id = ? AND user_id = ?")
    .get(pollId, userId);
}

function syncPollParticipantsFromResponses(pollId) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO poll_participants (poll_id, user_id, can_vote, has_veto, is_blocked, created_at)
    SELECT responses.poll_id, responses.user_id, 1, 0, 0, ?
    FROM responses
    WHERE responses.poll_id = ?
      AND responses.user_id IS NOT NULL
  `).run(now, pollId);
}

function getPollParticipantRights(pollId, userId) {
  if (!userId) {
    return getDefaultParticipantRights();
  }

  const row = db
    .prepare("SELECT * FROM poll_participants WHERE poll_id = ? AND user_id = ?")
    .get(pollId, userId);
  if (!row) {
    return getDefaultParticipantRights();
  }

  return {
    canVote: Boolean(row.can_vote),
    hasVeto: Boolean(row.has_veto),
    isBlocked: Boolean(row.is_blocked),
  };
}

function listPollParticipants(pollId) {
  syncPollParticipantsFromResponses(pollId);

  const rows = db.prepare(`
    SELECT
      poll_participants.*,
      users.email AS user_email,
      users.name AS user_name,
      responses.id AS response_id,
      responses.updated_at AS response_updated_at
    FROM poll_participants
    JOIN users ON users.id = poll_participants.user_id
    LEFT JOIN responses
      ON responses.poll_id = poll_participants.poll_id
      AND responses.user_id = poll_participants.user_id
    WHERE poll_participants.poll_id = ?
    ORDER BY LOWER(COALESCE(NULLIF(users.name, ''), users.email)) ASC
  `).all(pollId);

  return rows.map(mapParticipantRow);
}

function cleanupGuestResponses() {
  const result = db.prepare("DELETE FROM responses WHERE user_id IS NULL").run();
  return result.changes || 0;
}

function calculateSuggestedDatesRanking(responses) {
  const counts = new Map();

  for (const response of responses) {
    const suggestedEntries =
      response?.suggestedDateEntries && response.suggestedDateEntries.length > 0
        ? normalizeSuggestedDateEntries(response.suggestedDateEntries)
        : normalizeSuggestedDateEntries(response?.suggestedDates);

    for (const entry of suggestedEntries) {
      const current = counts.get(entry.date) || {
        date: entry.date,
        count: 0,
        participants: [],
        timeSlots: new Map(),
      };
      current.count += 1;
      current.participants.push(response.name);

      for (const time of entry.times) {
        const currentSlot = current.timeSlots.get(time) || { time, count: 0, participants: [] };
        currentSlot.count += 1;
        currentSlot.participants.push(response.name);
        current.timeSlots.set(time, currentSlot);
      }

      counts.set(entry.date, current);
    }
  }

  const summary = Array.from(counts.values())
    .map((entry) => ({
      date: entry.date,
      count: entry.count,
      participants: entry.participants,
      timeSlots: Array.from(entry.timeSlots.values()).sort((left, right) => left.time.localeCompare(right.time)),
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const bestCount = summary.reduce((maxCount, entry) => Math.max(maxCount, entry.count), 0);
  return {
    summary,
    bestDates: summary.filter((entry) => entry.count === bestCount && summary.length > 0),
  };
}

function loadPollWithResponses(pollId, currentUser = null, req = null) {
  const pollRow = db.prepare("SELECT * FROM polls WHERE id = ?").get(pollId);
  if (!pollRow) {
    return null;
  }

  syncPollParticipantsFromResponses(pollId);

  const responseRows = db
    .prepare(`
      SELECT
        responses.*,
        users.email AS user_email,
        users.name AS user_name,
        poll_participants.has_veto AS has_veto,
        poll_participants.can_vote AS can_vote,
        poll_participants.is_blocked AS is_blocked
      FROM responses
      LEFT JOIN users ON users.id = responses.user_id
      LEFT JOIN poll_participants
        ON poll_participants.poll_id = responses.poll_id
        AND poll_participants.user_id = responses.user_id
      WHERE responses.poll_id = ?
      ORDER BY responses.updated_at DESC, responses.id DESC
    `)
    .all(pollId);

  const poll = mapPollRow(pollRow, req);
  const responses = responseRows.map(mapResponseRow);
  const results = calculatePollResults(poll, responses);

  const owner = poll.userId
    ? db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(poll.userId)
    : null;

  const participantRights = currentUser
    ? getPollParticipantRights(poll.id, currentUser.id)
    : getDefaultParticipantRights();

  return {
    poll,
    owner: owner
      ? { id: owner.id, email: owner.email, name: owner.name || "" }
      : null,
    permissions: {
      canManage: Boolean(currentUser && poll.userId && currentUser.id === poll.userId),
      canRespond: Boolean(currentUser) && participantRights.canVote && !participantRights.isBlocked,
    },
    participant: participantRights,
    responses,
    results,
    user: currentUser
      ? { id: currentUser.id, email: currentUser.email, name: currentUser.name || "" }
      : null,
  };
}

function getPollOwnerOrThrow(pollId, userId) {
  const poll = db.prepare("SELECT * FROM polls WHERE id = ?").get(pollId);
  if (!poll) {
    return null;
  }
  if (poll.user_id !== userId) {
    return false;
  }
  return poll;
}

function parsePaginationValue(value, fallback, max = 50) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function buildDashboardPayload(req, userId, options = {}) {
  const paginated = Boolean(options.paginated);
  const pageSize = parsePaginationValue(options.pageSize, 12);
  const requestedPage = parsePaginationValue(options.page, 1, 100000);
  const totalPolls = Number(db.prepare("SELECT COUNT(*) AS count FROM polls WHERE user_id = ?").get(userId)?.count || 0);
  const totalPages = paginated ? Math.max(1, Math.ceil(totalPolls / pageSize)) : 1;
  const page = paginated ? Math.min(requestedPage, totalPages) : 1;
  const offset = paginated ? (page - 1) * pageSize : 0;
  const paginationSql = paginated ? "LIMIT ? OFFSET ?" : "";
  const queryParameters = paginated ? [userId, pageSize, offset] : [userId];
  const rows = db
    .prepare(`
      SELECT
        polls.*,
        COUNT(responses.id) AS response_count,
        MAX(responses.updated_at) AS latest_response_at
      FROM polls
      LEFT JOIN responses ON responses.poll_id = polls.id
      WHERE polls.user_id = ?
      GROUP BY polls.id
      ORDER BY COALESCE(polls.last_response_at, polls.updated_at, polls.created_at) DESC
      ${paginationSql}
    `)
    .all(...queryParameters);

  const polls = rows.map((row) => {
    const mapped = mapPollRow(row, req);
    const responses = db.prepare("SELECT * FROM responses WHERE poll_id = ?").all(row.id).map(mapResponseRow);
    const results = calculatePollResults(mapped, responses);

    return {
      ...mapped,
      responseCount: Number(row.response_count || 0),
      latestResponseAt: row.latest_response_at || null,
      bestDates: results.bestDates,
    };
  });

  const statsRow = db.prepare(`
    SELECT
      COUNT(*) AS total_polls,
      COALESCE(SUM(poll_rows.response_count), 0) AS total_responses,
      COALESCE(SUM(CASE WHEN poll_rows.response_count > 0 THEN 1 ELSE 0 END), 0) AS active_polls,
      COALESCE(SUM(CASE WHEN poll_rows.allow_email_invites = 1 THEN 1 ELSE 0 END), 0) AS invite_enabled_polls
    FROM (
      SELECT
        polls.id,
        polls.allow_email_invites,
        COUNT(responses.id) AS response_count
      FROM polls
      LEFT JOIN responses ON responses.poll_id = polls.id
      WHERE polls.user_id = ?
      GROUP BY polls.id
    ) AS poll_rows
  `).get(userId) || {};

  return {
    polls,
    stats: {
      totalPolls: Number(statsRow.total_polls || 0),
      totalResponses: Number(statsRow.total_responses || 0),
      activePolls: Number(statsRow.active_polls || 0),
      inviteEnabledPolls: Number(statsRow.invite_enabled_polls || 0),
    },
    pagination: {
      page,
      pageSize,
      totalItems: totalPolls,
      totalPages,
    },
  };
}

function buildMyPollsPayload(req, userId, options = {}) {
  const pageSize = parsePaginationValue(options.pageSize, 12);
  const requestedPage = parsePaginationValue(options.page, 1, 100000);
  const total = Number(db.prepare("SELECT COUNT(*) AS count FROM polls WHERE user_id = ?").get(userId)?.count || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * pageSize;

  const rows = db
    .prepare(`
      SELECT
        polls.*,
        COUNT(responses.id) AS response_count,
        MAX(responses.updated_at) AS latest_response_at
      FROM polls
      LEFT JOIN responses ON responses.poll_id = polls.id
      WHERE polls.user_id = ?
      GROUP BY polls.id
      ORDER BY polls.created_at DESC, polls.id DESC
      LIMIT ? OFFSET ?
    `)
    .all(userId, pageSize, offset);

  const polls = rows.map((row) => {
    const mapped = mapPollRow(row, req);
    const responses = db.prepare("SELECT * FROM responses WHERE poll_id = ?").all(row.id).map(mapResponseRow);
    const results = calculatePollResults(mapped, responses);

    return {
      ...mapped,
      responseCount: Number(row.response_count || 0),
      latestResponseAt: row.latest_response_at || null,
      bestDates: results.bestDates,
    };
  });

  return {
    polls,
    total,
    page,
    pageSize,
  };
}

function buildParticipatedPollsPayload(req, userId, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : null;
  const totalPolls = Number(
    db.prepare(`
      SELECT COUNT(DISTINCT polls.id) AS count
      FROM polls
      JOIN responses ON responses.poll_id = polls.id
      WHERE responses.user_id = ?
        AND polls.user_id != ?
    `).get(userId, userId)?.count || 0
  );
  const limitSql = limit ? "LIMIT ?" : "";
  const queryParameters = limit ? [userId, userId, limit] : [userId, userId];
  const rows = db
    .prepare(`
      SELECT
        polls.*,
        MAX(responses.created_at) AS voted_at
      FROM polls
      JOIN responses ON responses.poll_id = polls.id
      WHERE responses.user_id = ?
        AND polls.user_id != ?
      GROUP BY polls.id
      ORDER BY MAX(responses.created_at) DESC
      ${limitSql}
    `)
    .all(...queryParameters);

  const polls = rows.map((row) => ({
    ...mapPollRow(row, req),
    votedAt: row.voted_at || null,
  }));

  return {
    polls,
    stats: {
      totalPolls,
    },
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

function bucketKey(prefix, key) {
  return `${prefix}:${key}`;
}

function cleanupBucket(bucket, now, windowMs) {
  bucket.timestamps = bucket.timestamps.filter((timestamp) => now - timestamp < windowMs);
}

function createRateLimit(options) {
  const limit = options.limit ?? 10;
  const windowMs = options.windowMs ?? 60 * 1000;
  const keyPrefix = options.keyPrefix || "global";
  const keyFn = options.keyFn || ((req) => req.ip);

  return (req, res, next) => {
    const now = Date.now();
    const key = bucketKey(keyPrefix, keyFn(req));
    const bucket = rateLimitBuckets.get(key) || { timestamps: [] };
    cleanupBucket(bucket, now, windowMs);

    if (bucket.timestamps.length >= limit) {
      return res.status(429).json({ error: "Zu viele Anfragen. Bitte warte kurz." });
    }

    bucket.timestamps.push(now);
    rateLimitBuckets.set(key, bucket);
    next();
  };
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
    serializeCookie("csrf_token", csrfToken, {
      ...getCookieSettings(req, false),
      maxAge: 7 * 24 * 60 * 60,
    })
  );
  next();
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
    serializeCookie("session_id", sessionId, {
      ...getCookieSettings(req, true),
      maxAge: Math.floor(SESSION_TIMEOUT_MS / 1000),
    })
  );
}

function destroySession(res, req) {
  const sessionId = req.cookies.session_id;
  if (sessionId) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }
  clearCookie(res, "session_id", req, true);
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
    serializeCookie("session_id", sessionId, {
      ...getCookieSettings(req, true),
      maxAge: Math.floor(SESSION_TIMEOUT_MS / 1000),
    })
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
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  const headerToken = req.get("x-csrf-token");
  const cookieToken = req.cookies.csrf_token;
  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return res.status(403).json({ error: "CSRF-Pruefung fehlgeschlagen." });
  }

  next();
}

function requireAuth(req, res, next) {
  if (!req.currentUser) {
    return res.status(401).json({ error: "Bitte zuerst einloggen." });
  }
  next();
}

function hasRegisteredRoute(appInstance, method, routePath, prefix = "") {
  const stack = appInstance?.router?.stack || appInstance?.stack || [];
  const normalizedMethod = String(method || "").toLowerCase();
  return stack.some((layer) => {
    if (!layer.route || !layer.route.methods?.[normalizedMethod]) {
      if (!layer.handle?.stack) {
        return false;
      }

      const matchedMount = Array.isArray(layer.matchers)
        ? layer.matchers
            .map((matcher) => matcher(routePath))
            .find(Boolean)?.path || ""
        : "";
      const nextPrefix = matchedMount ? `${prefix}${matchedMount}` : prefix;
      return hasRegisteredRoute(layer.handle, normalizedMethod, routePath, nextPrefix);
    }

    const fullPath = `${prefix}${layer.route.path}`;
    if (fullPath === routePath) {
      return true;
    }

    return Array.isArray(layer.route.path) && layer.route.path.some((pathEntry) => `${prefix}${pathEntry}` === routePath);
  });
}

function assertRequiredRoutes(appInstance) {
  const requiredRoutes = [
    ["get", "/api/user/my-polls"],
  ];

  for (const [method, routePath] of requiredRoutes) {
    if (!hasRegisteredRoute(appInstance, method, routePath)) {
      throw new Error(`Pflicht-Route fehlt: ${String(method).toUpperCase()} ${routePath}`);
    }
  }
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

function appendMailLog(payload) {
  const line = `${JSON.stringify({ createdAt: new Date().toISOString(), ...payload })}\n`;
  fs.appendFileSync(MAIL_LOG_PATH, line, "utf8");
}

function deliverEmail({ to, subject, text, meta = {} }) {
  appendMailLog({ to, subject, text, meta });
}

function sendInvitationEmails(req, poll, inviteEmails) {
  if (!inviteEmails.length || !poll.allowEmailInvites) {
    return 0;
  }

  for (const email of inviteEmails) {
    deliverEmail({
      to: email,
      subject: `Einladung: ${poll.title}`,
      text: [
        `Du wurdest zu einer Termin-Abstimmung eingeladen.`,
        ``,
        `Titel: ${poll.title}`,
        `Beschreibung: ${poll.description}`,
        poll.inviteMessage ? `Nachricht: ${poll.inviteMessage}` : "",
        `Link: ${getShareUrl(req, poll.id)}`,
      ].filter(Boolean).join("\n"),
      meta: { type: "poll_invitation", pollId: poll.id },
    });
  }

  return inviteEmails.length;
}

function sendOwnerResponseNotification(req, pollId, responseName, isUpdate) {
  const poll = db.prepare("SELECT * FROM polls WHERE id = ?").get(pollId);
  if (!poll || !poll.user_id || !poll.notification_email_enabled) {
    return;
  }

  const owner = db.prepare("SELECT * FROM users WHERE id = ?").get(poll.user_id);
  if (!owner || !owner.notify_on_response) {
    return;
  }

  deliverEmail({
    to: owner.email,
    subject: `${isUpdate ? "Aktualisierte" : "Neue"} Antwort fuer ${poll.title}`,
    text: [
      `${responseName} hat ${isUpdate ? "eine Antwort aktualisiert" : "geantwortet"}.`,
      `Umfrage: ${poll.title}`,
      `Link: ${getShareUrl(req, poll.id)}`,
    ].join("\n"),
    meta: { type: "poll_response", pollId: poll.id, responseName },
  });
}

function sendDailySummaryIfDue(req, userId) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user || !user.daily_summary) {
    return;
  }

  const lastSentAt = user.daily_summary_last_sent_at ? new Date(user.daily_summary_last_sent_at).getTime() : 0;
  if (lastSentAt && Date.now() - lastSentAt < 24 * 60 * 60 * 1000) {
    return;
  }

  const polls = buildDashboardPayload(req, userId).polls;
  if (polls.length === 0) {
    return;
  }

  const lines = polls.slice(0, 10).map((poll) => {
    const bestLabel = poll.bestDates.length > 0
      ? poll.bestDates.map((entry) => formatBestDateEntry(entry)).join(", ")
      : "noch keine Antworten";
    return `- ${poll.title}: ${poll.responseCount} Antworten, Top-Termine: ${bestLabel}`;
  });

  deliverEmail({
    to: user.email,
    subject: "Taegliche Termin-Abstimmungs-Zusammenfassung",
    text: ["Deine letzten Umfragen:", ...lines].join("\n"),
    meta: { type: "daily_summary", userId },
  });

  db.prepare("UPDATE users SET daily_summary_last_sent_at = ? WHERE id = ?").run(new Date().toISOString(), userId);
}

function formatIcsDate(date) {
  return date.replaceAll("-", "");
}

function escapeIcsText(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function buildIcsContent(req, poll, date) {
  const dtStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const start = formatIcsDate(date);
  const endDate = new Date(`${date}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const end = formatIcsDate(endDate.toISOString().slice(0, 10));

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Termin-Abstimmung//DE",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${poll.id}-${start}@termin-abstimmung`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${escapeIcsText(poll.title)}`,
    `DESCRIPTION:${escapeIcsText(poll.description)}`,
    `URL:${escapeIcsText(getShareUrl(req, poll.id))}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  if (req.currentUser) {
    sendDailySummaryIfDue(req, req.currentUser.id);
  }

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

app.post("/api/auth/register", requireCsrf, createRateLimit({ keyPrefix: "register", limit: 6 }), (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const passwordCheck = validatePassword(req.body?.password);
    const name = normalizeText(req.body?.name, 120);

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
      db.prepare(`
        UPDATE users
        SET password_hash = ?, name = ?, created_at = COALESCE(created_at, ?)
        WHERE id = ?
      `).run(passwordHash, name, createdAt, existingUser.id);
    } else {
      db.prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
        email,
        name,
        passwordHash,
        createdAt
      );
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    destroySession(res, req);
    createSession(res, req, user.id);

    res.status(201).json({
      message: "Konto erstellt. Du bist jetzt eingeloggt.",
      user: mapUserRow(user),
    });
  } catch (error) {
    console.error("Fehler bei der Registrierung:", error);
    res.status(500).json({ error: "Die Registrierung konnte nicht gespeichert werden." });
  }
});

app.post("/api/auth/login", requireCsrf, createRateLimit({
  keyPrefix: "login",
  limit: 8,
  keyFn: (req) => `${req.ip}:${normalizeEmail(req.body?.email || "")}`,
}), (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "E-Mail oder Passwort ist falsch." });
    }

    destroySession(res, req);
    createSession(res, req, user.id);

    res.json({
      message: "Login erfolgreich.",
      user: mapUserRow(user),
    });
  } catch (error) {
    console.error("Fehler beim Login:", error);
    res.status(500).json({ error: "Der Login konnte nicht abgeschlossen werden." });
  }
});

app.post("/api/auth/forgot-password", requireCsrf, createRateLimit({ keyPrefix: "forgot", limit: 5 }), (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Bitte gib eine gueltige E-Mail-Adresse ein." });
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !user.password_hash) {
      return res.json({ message: "Falls ein Konto existiert, wurde ein Reset-Link erzeugt." });
    }

    const { token, expiresAt } = issuePasswordResetToken(user.id);
    deliverEmail({
      to: email,
      subject: "Passwort zuruecksetzen",
      text: `Reset-Link: ${getBaseUrl(req)}/reset-password?token=${token}\nGueltig bis: ${expiresAt}`,
      meta: { type: "password_reset", userId: user.id },
    });

    res.json({
      message: "Reset-Link erzeugt. In dieser lokalen Version wird der Link direkt angezeigt.",
      resetUrl: `${getBaseUrl(req)}/reset-password?token=${token}`,
      expiresAt,
    });
  } catch (error) {
    console.error("Fehler beim Erzeugen des Passwort-Reset-Links:", error);
    res.status(500).json({ error: "Der Reset-Link konnte nicht erzeugt werden." });
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

    res.json({ email: user.email, expiresAt: user.reset_token_expires_at });
  } catch (error) {
    console.error("Fehler beim Pruefen des Reset-Tokens:", error);
    res.status(500).json({ error: "Der Reset-Link konnte nicht geprueft werden." });
  }
});

app.post("/api/auth/reset-password", requireCsrf, createRateLimit({ keyPrefix: "reset", limit: 8 }), (req, res) => {
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

    db.prepare("UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires_at = NULL WHERE id = ?").run(
      bcrypt.hashSync(passwordCheck.value, 12),
      user.id
    );

    destroySession(res, req);
    createSession(res, req, user.id);

    res.json({
      message: "Passwort gespeichert. Du bist jetzt eingeloggt.",
      user: mapUserRow(db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)),
    });
  } catch (error) {
    console.error("Fehler beim Zuruecksetzen des Passworts:", error);
    res.status(500).json({ error: "Das Passwort konnte nicht zurueckgesetzt werden." });
  }
});

app.post("/api/auth/logout", requireCsrf, (req, res) => {
  destroySession(res, req);
  res.json({ message: "Logout erfolgreich." });
});

userApi.get("/profile", requireAuth, (req, res) => {
  try {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.currentUser.id);
    res.json(mapUserRow(user));
  } catch (error) {
    console.error("Fehler beim Laden des Profils:", error);
    res.status(500).json({ error: "Das Profil konnte nicht geladen werden." });
  }
});

userApi.put("/profile", requireCsrf, requireAuth, (req, res) => {
  try {
    const name = normalizeText(req.body?.name, 120);
    if (name.length < 2) {
      return res.status(400).json({ error: "Der Name muss mindestens 2 Zeichen lang sein." });
    }

    const notifyOnResponse = normalizeBoolean(req.body?.notifyOnResponse, true);
    const dailySummary = normalizeBoolean(req.body?.dailySummary, false);

    db.prepare(`
      UPDATE users
      SET name = ?, notify_on_response = ?, daily_summary = ?
      WHERE id = ?
    `).run(name, notifyOnResponse ? 1 : 0, dailySummary ? 1 : 0, req.currentUser.id);

    res.json(mapUserRow(db.prepare("SELECT * FROM users WHERE id = ?").get(req.currentUser.id)));
  } catch (error) {
    console.error("Fehler beim Aktualisieren des Profils:", error);
    res.status(500).json({ error: "Das Profil konnte nicht gespeichert werden." });
  }
});

userApi.put("/password", requireCsrf, requireAuth, createRateLimit({ keyPrefix: "password", limit: 10 }), (req, res) => {
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

    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
      bcrypt.hashSync(newPasswordCheck.value, 12),
      req.currentUser.id
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Fehler beim Aendern des Passworts:", error);
    res.status(500).json({ error: "Das Passwort konnte nicht geaendert werden." });
  }
});

userApi.delete("/account", requireCsrf, requireAuth, (req, res) => {
  try {
    const userId = req.currentUser.id;
    const deleteAccount = db.transaction(() => {
      const polls = db.prepare("SELECT id FROM polls WHERE user_id = ?").all(userId);
      for (const poll of polls) {
        db.prepare("DELETE FROM responses WHERE poll_id = ?").run(poll.id);
        db.prepare("DELETE FROM polls WHERE id = ?").run(poll.id);
      }
      db.prepare("DELETE FROM responses WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    });

    deleteAccount();
    destroySession(res, req);
    res.json({ success: true });
  } catch (error) {
    console.error("Fehler beim Loeschen des Kontos:", error);
    res.status(500).json({ error: "Das Konto konnte nicht geloescht werden." });
  }
});

userApi.get("/dashboard", requireAuth, (req, res) => {
  try {
    sendDailySummaryIfDue(req, req.currentUser.id);
    const profile = db.prepare("SELECT * FROM users WHERE id = ?").get(req.currentUser.id);
    res.json({
      user: mapUserRow(profile),
      ...buildDashboardPayload(req, req.currentUser.id),
    });
  } catch (error) {
    console.error("Fehler beim Laden des Dashboards:", error);
    res.status(500).json({ error: "Das Dashboard konnte nicht geladen werden." });
  }
});

userApi.get("/participated-polls", requireAuth, (req, res) => {
  try {
    res.json(buildParticipatedPollsPayload(req, req.currentUser.id, { limit: 3 }));
  } catch (error) {
    console.error("Fehler beim Laden der teilgenommenen Umfragen:", error);
    res.status(500).json({ error: "Die teilgenommenen Umfragen konnten nicht geladen werden." });
  }
});

userApi.get("/my-polls", requireAuth, (req, res) => {
  try {
    const page = parsePaginationValue(req.query?.page, 1, 100000);
    const pageSize = parsePaginationValue(req.query?.pageSize, 12);
    res.json(buildMyPollsPayload(req, req.currentUser.id, { page, pageSize }));
  } catch (error) {
    console.error("Fehler beim Laden aller eigenen Umfragen:", error);
    res.status(500).json({ error: "Die eigenen Umfragen konnten nicht geladen werden." });
  }
});

userApi.get("/all-participated", requireAuth, (req, res) => {
  try {
    res.json(buildParticipatedPollsPayload(req, req.currentUser.id));
  } catch (error) {
    console.error("Fehler beim Laden aller Teilnahmen:", error);
    res.status(500).json({ error: "Die Teilnahmen konnten nicht geladen werden." });
  }
});

userApi.get("/polls", requireAuth, (req, res) => {
  try {
    res.json(buildDashboardPayload(req, req.currentUser.id));
  } catch (error) {
    console.error("Fehler beim Laden der Polls:", error);
    res.status(500).json({ error: "Die Umfragen konnten nicht geladen werden." });
  }
});

app.use("/api/user", userApi);

app.post("/api/admin/cleanup-guest-responses", requireCsrf, requireAuth, (_req, res) => {
  try {
    const deletedCount = cleanupGuestResponses();
    res.json({
      success: true,
      deletedCount,
      message: `${deletedCount} Gast-Antworten wurden geloescht.`,
    });
  } catch (error) {
    console.error("Fehler beim Bereinigen der Gast-Antworten:", error);
    res.status(500).json({ error: "Die Gast-Antworten konnten nicht geloescht werden." });
  }
});

app.post("/api/polls", requireCsrf, requireAuth, createRateLimit({ keyPrefix: "poll-create", limit: 12 }), (req, res) => {
  try {
    const validation = validatePollInput(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.message });
    }

    const input = validation.value;
    const now = new Date().toISOString();
    const pollId = createToken(6);

    db.prepare(`
      INSERT INTO polls (
        id, title, description, dates, mode, created_at, updated_at, user_id,
        invite_message, notification_email_enabled, allow_email_invites, has_time_slots, time_slots, allow_time_slots
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pollId,
      input.title,
      input.description,
      JSON.stringify(input.dates),
      input.mode,
      now,
      now,
      req.currentUser.id,
      input.inviteMessage,
      input.notificationEmailEnabled ? 1 : 0,
      input.allowEmailInvites ? 1 : 0,
      input.allowTimeSlots ? 1 : 0,
      JSON.stringify(input.timeSlots),
      input.allowTimeSlots ? 1 : 0
    );

    const poll = mapPollRow(db.prepare("SELECT * FROM polls WHERE id = ?").get(pollId), req);
    const invitedCount = input.sendInvites ? sendInvitationEmails(req, poll, input.inviteEmails) : 0;

    res.status(201).json({
      poll,
      invitedCount,
      message: invitedCount > 0 ? `${invitedCount} Einladungen wurden protokolliert.` : "Umfrage erstellt.",
    });
  } catch (error) {
    console.error("Fehler beim Erstellen des Polls:", error);
    res.status(500).json({ error: "Die Umfrage konnte nicht erstellt werden." });
  }
});

app.get("/api/polls/:pollId", (req, res) => {
  try {
    const data = loadPollWithResponses(req.params.pollId, req.currentUser, req);
    if (!data) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }

    res.json(data);
  } catch (error) {
    console.error("Fehler beim Laden des Polls:", error);
    res.status(500).json({ error: "Der Poll konnte nicht geladen werden." });
  }
});

app.put("/api/polls/:pollId", requireCsrf, requireAuth, (req, res) => {
  try {
    const existing = getPollOwnerOrThrow(req.params.pollId, req.currentUser.id);
    if (existing === null) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }
    if (existing === false) {
      return res.status(403).json({ error: "Nicht erlaubt." });
    }

    const validation = validatePollInput(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.message });
    }

    const input = validation.value;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE polls
      SET title = ?, description = ?, dates = ?, mode = ?, updated_at = ?, invite_message = ?,
          notification_email_enabled = ?, allow_email_invites = ?, has_time_slots = ?, time_slots = ?, allow_time_slots = ?
      WHERE id = ?
    `).run(
      input.title,
      input.description,
      JSON.stringify(input.dates),
      input.mode,
      now,
      input.inviteMessage,
      input.notificationEmailEnabled ? 1 : 0,
      input.allowEmailInvites ? 1 : 0,
      input.allowTimeSlots ? 1 : 0,
      JSON.stringify(input.timeSlots),
      input.allowTimeSlots ? 1 : 0,
      req.params.pollId
    );

    const poll = mapPollRow(db.prepare("SELECT * FROM polls WHERE id = ?").get(req.params.pollId), req);
    const invitedCount = input.sendInvites ? sendInvitationEmails(req, poll, input.inviteEmails) : 0;
    res.json({
      poll,
      invitedCount,
      message: invitedCount > 0 ? `${invitedCount} Einladungen wurden protokolliert.` : "Umfrage aktualisiert.",
    });
  } catch (error) {
    console.error("Fehler beim Aktualisieren des Polls:", error);
    res.status(500).json({ error: "Die Umfrage konnte nicht aktualisiert werden." });
  }
});

app.post("/api/polls/:pollId/duplicate", requireCsrf, requireAuth, (req, res) => {
  try {
    const existing = getPollOwnerOrThrow(req.params.pollId, req.currentUser.id);
    if (existing === null) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }
    if (existing === false) {
      return res.status(403).json({ error: "Nicht erlaubt." });
    }

    const newId = createToken(6);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO polls (
        id, title, description, dates, mode, created_at, updated_at, user_id,
        invite_message, notification_email_enabled, allow_email_invites,
        has_time_slots, time_slots, allow_time_slots
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newId,
      `${existing.title} (Kopie)`.slice(0, 120),
      existing.description,
      existing.dates,
      existing.mode,
      now,
      now,
      req.currentUser.id,
      existing.invite_message || "",
      existing.notification_email_enabled,
      existing.allow_email_invites,
      existing.has_time_slots || 0,
      existing.time_slots || "{}",
      existing.allow_time_slots || 0
    );

    res.status(201).json({
      poll: mapPollRow(db.prepare("SELECT * FROM polls WHERE id = ?").get(newId), req),
      message: "Umfrage dupliziert.",
    });
  } catch (error) {
    console.error("Fehler beim Duplizieren des Polls:", error);
    res.status(500).json({ error: "Die Umfrage konnte nicht dupliziert werden." });
  }
});

app.post("/api/polls/:pollId/invitations", requireCsrf, requireAuth, (req, res) => {
  try {
    const existing = getPollOwnerOrThrow(req.params.pollId, req.currentUser.id);
    if (existing === null) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }
    if (existing === false) {
      return res.status(403).json({ error: "Nicht erlaubt." });
    }

    const inviteEmails = normalizeInviteEmails(req.body?.inviteEmails);
    if (inviteEmails.length === 0) {
      return res.status(400).json({ error: "Bitte gib mindestens eine gueltige E-Mail-Adresse ein." });
    }

    const poll = mapPollRow(existing, req);
    poll.inviteMessage = normalizeText(req.body?.inviteMessage || existing.invite_message, 500);
    poll.allowEmailInvites = Boolean(existing.allow_email_invites);
    const invitedCount = sendInvitationEmails(req, poll, inviteEmails);
    res.json({ invitedCount, message: `${invitedCount} Einladungen wurden protokolliert.` });
  } catch (error) {
    console.error("Fehler beim Senden der Einladungen:", error);
    res.status(500).json({ error: "Die Einladungen konnten nicht verarbeitet werden." });
  }
});

app.get("/api/polls/:pollId/participants", requireAuth, (req, res) => {
  try {
    const poll = getPollOwnerOrThrow(req.params.pollId, req.currentUser.id);
    if (poll === null) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }
    if (poll === false) {
      return res.status(403).json({ error: "Nicht erlaubt." });
    }

    res.json({ participants: listPollParticipants(req.params.pollId) });
  } catch (error) {
    console.error("Fehler beim Laden der Teilnehmer:", error);
    res.status(500).json({ error: "Die Teilnehmer konnten nicht geladen werden." });
  }
});

app.put("/api/polls/:pollId/participants/:userId", requireCsrf, requireAuth, (req, res) => {
  try {
    const poll = getPollOwnerOrThrow(req.params.pollId, req.currentUser.id);
    if (poll === null) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }
    if (poll === false) {
      return res.status(403).json({ error: "Nicht erlaubt." });
    }

    const targetUserId = Number(req.params.userId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "Ungueltiger Benutzer." });
    }

    const user = db.prepare("SELECT id FROM users WHERE id = ?").get(targetUserId);
    if (!user) {
      return res.status(404).json({ error: "Benutzer nicht gefunden." });
    }

    ensurePollParticipant(req.params.pollId, targetUserId);
    const canVote = normalizeBoolean(req.body?.canVote, true);
    const hasVeto = normalizeBoolean(req.body?.hasVeto, false);
    const isBlocked = normalizeBoolean(req.body?.isBlocked, false);

    db.prepare(`
      UPDATE poll_participants
      SET can_vote = ?, has_veto = ?, is_blocked = ?
      WHERE poll_id = ? AND user_id = ?
    `).run(canVote ? 1 : 0, hasVeto ? 1 : 0, isBlocked ? 1 : 0, req.params.pollId, targetUserId);

    res.json({
      participant: mapParticipantRow(
        db.prepare(`
          SELECT
            poll_participants.*,
            users.email AS user_email,
            users.name AS user_name,
            responses.id AS response_id,
            responses.updated_at AS response_updated_at
          FROM poll_participants
          JOIN users ON users.id = poll_participants.user_id
          LEFT JOIN responses
            ON responses.poll_id = poll_participants.poll_id
            AND responses.user_id = poll_participants.user_id
          WHERE poll_participants.poll_id = ? AND poll_participants.user_id = ?
        `).get(req.params.pollId, targetUserId)
      ),
    });
  } catch (error) {
    console.error("Fehler beim Aktualisieren der Teilnehmerrechte:", error);
    res.status(500).json({ error: "Die Teilnehmerrechte konnten nicht gespeichert werden." });
  }
});

app.get("/api/polls/:pollId/time-slots", (req, res) => {
  try {
    const poll = mapPollRow(db.prepare("SELECT * FROM polls WHERE id = ?").get(req.params.pollId), req);
    if (!poll) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }

    res.json({ timeSlots: listPollTimeSlots(poll) });
  } catch (error) {
    console.error("Fehler beim Laden der Uhrzeiten:", error);
    res.status(500).json({ error: "Die Uhrzeiten konnten nicht geladen werden." });
  }
});

app.post("/api/polls/:pollId/time-slots", requireCsrf, requireAuth, (req, res) => {
  try {
    const existing = getPollOwnerOrThrow(req.params.pollId, req.currentUser.id);
    if (existing === null) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }
    if (existing === false) {
      return res.status(403).json({ error: "Nicht erlaubt." });
    }

    const pollDates = parseJsonArray(existing.dates);
    const dateId = normalizeText(req.body?.dateId, 10);
    const time = normalizeText(req.body?.time, 5);
    if (!pollDates.includes(dateId)) {
      return res.status(400).json({ error: "Ungueltiges Datum." });
    }
    if (!isValidTimeValue(time)) {
      return res.status(400).json({ error: "Ungueltige Uhrzeit." });
    }

    const timeSlotsByDate = parseJsonObject(existing.time_slots);
    const currentSlots = Array.isArray(timeSlotsByDate[dateId]) ? timeSlotsByDate[dateId] : [];
    if (currentSlots.includes(time)) {
      return res.status(409).json({ error: "Diese Uhrzeit existiert bereits." });
    }

    timeSlotsByDate[dateId] = [...currentSlots, time].sort();
    setPollTimeSlots(existing.id, timeSlotsByDate);

    const poll = mapPollRow(db.prepare("SELECT * FROM polls WHERE id = ?").get(existing.id), req);
    const slotsForDate = listPollTimeSlots(poll).filter((slot) => slot.dateId === dateId);
    const slot = slotsForDate.find((entry) => entry.time === time);

    res.status(201).json({ slot, timeSlots: listPollTimeSlots(poll) });
  } catch (error) {
    console.error("Fehler beim Hinzufuegen der Uhrzeit:", error);
    res.status(500).json({ error: "Die Uhrzeit konnte nicht gespeichert werden." });
  }
});

app.delete("/api/time-slots/:slotId", requireCsrf, requireAuth, (req, res) => {
  try {
    const parsedSlot = parseTimeSlotId(req.params.slotId);
    if (!parsedSlot) {
      return res.status(400).json({ error: "Ungueltige Uhrzeit." });
    }

    const existing = getPollOwnerOrThrow(parsedSlot.pollId, req.currentUser.id);
    if (existing === null) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }
    if (existing === false) {
      return res.status(403).json({ error: "Nicht erlaubt." });
    }

    const timeSlotsByDate = parseJsonObject(existing.time_slots);
    const currentSlots = Array.isArray(timeSlotsByDate[parsedSlot.dateId]) ? timeSlotsByDate[parsedSlot.dateId] : [];
    if (!currentSlots.includes(parsedSlot.time)) {
      return res.status(404).json({ error: "Uhrzeit nicht gefunden." });
    }

    const nextSlots = currentSlots.filter((entry) => entry !== parsedSlot.time);
    if (nextSlots.length > 0) {
      timeSlotsByDate[parsedSlot.dateId] = nextSlots;
    } else {
      delete timeSlotsByDate[parsedSlot.dateId];
    }

    setPollTimeSlots(existing.id, timeSlotsByDate);
    const poll = mapPollRow(db.prepare("SELECT * FROM polls WHERE id = ?").get(existing.id), req);

    res.json({ deleted: true, timeSlots: listPollTimeSlots(poll) });
  } catch (error) {
    console.error("Fehler beim Loeschen der Uhrzeit:", error);
    res.status(500).json({ error: "Die Uhrzeit konnte nicht geloescht werden." });
  }
});

app.post("/api/polls/:pollId/responses", requireCsrf, createRateLimit({ keyPrefix: "responses", limit: 30 }), (req, res) => {
  try {
    if (!req.session?.userId || !req.currentUser) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const data = loadPollWithResponses(req.params.pollId, req.currentUser, req);
    if (!data) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }

    const participantRights = getPollParticipantRights(data.poll.id, req.session.userId);
    if (participantRights.isBlocked) {
      return res.status(403).json({ error: "Du wurdest fuer diese Umfrage gesperrt." });
    }
    if (!participantRights.canVote) {
      return res.status(403).json({ error: "Du darfst in dieser Umfrage aktuell nicht abstimmen." });
    }

    let availabilities = {};
    let slotAvailabilities = {};
    let suggestedDates = [];
    if (pollUsesTimeSlots(data.poll)) {
      const slotResponsesCheck = validateSlotResponses(data.poll, req.body?.slotResponses);
      if (!slotResponsesCheck.ok) {
        return res.status(400).json({ error: slotResponsesCheck.message });
      }
      slotAvailabilities = slotResponsesCheck.value;
    } else if (data.poll.mode === "fixed") {
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
    const serializedSlotAvailabilities = JSON.stringify(slotAvailabilities);
    const serializedSuggestedDates = JSON.stringify(suggestedDates);
    const responseName = req.currentUser.name || req.currentUser.email;
    const existing = db
      .prepare(`
        SELECT id
        FROM responses
        WHERE poll_id = ?
          AND user_id = ?
        LIMIT 1
      `)
      .get(data.poll.id, req.session.userId);

    const isUpdate = Boolean(existing);
    if (existing) {
      db.prepare(`
        UPDATE responses
        SET name = ?, user_id = ?, availabilities = ?, slot_availabilities = ?, suggested_dates = ?, updated_at = ?
        WHERE id = ?
      `).run(
        responseName,
        req.session.userId,
        serializedAvailabilities,
        serializedSlotAvailabilities,
        serializedSuggestedDates,
        timestamp,
        existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO responses (
          poll_id, user_id, name, availabilities, slot_availabilities, suggested_dates, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.poll.id,
        req.session.userId,
        responseName,
        serializedAvailabilities,
        serializedSlotAvailabilities,
        serializedSuggestedDates,
        timestamp,
        timestamp
      );
    }

    ensurePollParticipant(data.poll.id, req.session.userId);
    db.prepare("UPDATE polls SET last_response_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, data.poll.id);
    sendOwnerResponseNotification(req, data.poll.id, responseName, isUpdate);

    res.status(201).json(loadPollWithResponses(req.params.pollId, req.currentUser, req));
  } catch (error) {
    console.error("Fehler beim Speichern der Antwort:", error);
    res.status(500).json({ error: "Die Antwort konnte nicht gespeichert werden." });
  }
});

app.delete("/api/polls/:pollId/responses/:responseId", requireCsrf, requireAuth, (req, res) => {
  try {
    const poll = db.prepare("SELECT * FROM polls WHERE id = ?").get(req.params.pollId);
    if (!poll) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }
    if (poll.user_id !== req.currentUser.id) {
      return res.status(403).json({ error: "Nicht erlaubt." });
    }

    const responseId = Number(req.params.responseId);
    if (!Number.isInteger(responseId) || responseId <= 0) {
      return res.status(400).json({ error: "Ungueltige Antwort." });
    }

    const deleted = db.prepare("DELETE FROM responses WHERE id = ? AND poll_id = ?").run(responseId, req.params.pollId);
    if (!deleted.changes) {
      return res.status(404).json({ error: "Antwort nicht gefunden." });
    }

    const latestResponse = db
      .prepare("SELECT MAX(updated_at) AS latest_response_at FROM responses WHERE poll_id = ?")
      .get(req.params.pollId);
    db.prepare("UPDATE polls SET last_response_at = ?, updated_at = ? WHERE id = ?").run(
      latestResponse?.latest_response_at || null,
      new Date().toISOString(),
      req.params.pollId
    );

    res.json(loadPollWithResponses(req.params.pollId, req.currentUser, req));
  } catch (error) {
    console.error("Fehler beim Loeschen der Antwort:", error);
    res.status(500).json({ error: "Die Antwort konnte nicht geloescht werden." });
  }
});

app.get("/api/polls/:pollId/ics", (req, res) => {
  try {
    const data = loadPollWithResponses(req.params.pollId, req.currentUser, req);
    if (!data) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }

    const requestedDate = normalizeText(req.query?.date || "", 10);
    const bestDate = requestedDate
      || data.results.bestDates[0]?.date
      || data.poll.dates[0]
      || null;

    if (!bestDate || !/^\d{4}-\d{2}-\d{2}$/.test(bestDate)) {
      return res.status(400).json({ error: "Fuer diese Umfrage ist kein exportierbares Datum verfuegbar." });
    }

    const ics = buildIcsContent(req, data.poll, bestDate);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${data.poll.id}-${bestDate}.ics"`);
    res.send(ics);
  } catch (error) {
    console.error("Fehler beim Erstellen des ICS-Exports:", error);
    res.status(500).json({ error: "Der Kalender-Export konnte nicht erstellt werden." });
  }
});

app.delete("/api/polls/:pollId", requireCsrf, requireAuth, (req, res) => {
  try {
    const poll = getPollOwnerOrThrow(req.params.pollId, req.currentUser.id);
    if (poll === null) {
      return res.status(404).json({ error: "Poll nicht gefunden." });
    }
    if (poll === false) {
      return res.status(403).json({ error: "Nicht erlaubt." });
    }

    db.prepare("DELETE FROM responses WHERE poll_id = ?").run(req.params.pollId);
    db.prepare("DELETE FROM polls WHERE id = ?").run(req.params.pollId);
    res.json({ success: true });
  } catch (error) {
    console.error("Fehler beim Loeschen des Polls:", error);
    res.status(500).json({ error: "Die Umfrage konnte nicht geloescht werden." });
  }
});

app.get(
  [
    "/",
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
    "/dashboard",
    "/account",
    "/create",
    "/my-polls",
    "/participated",
    "/poll/:pollId",
  ],
  (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
  }
);

app.use("/api", (req, res) => {
  res.status(404).json({ error: `Route nicht gefunden: ${req.method} ${req.originalUrl}` });
});

app.use((error, _req, res, _next) => {
  console.error("Unerwarteter Serverfehler:", error);
  res.status(500).json({ error: "Interner Serverfehler." });
});

function startServer(port = PORT, host = HOST) {
  assertRequiredRoutes(app);
  return app.listen(port, host, () => {
    const deletedCount = cleanupGuestResponses();
    console.log(`Cleanup: ${deletedCount} Gast-Antworten geloescht`);
    console.log(`Termin-Abstimmung laeuft auf http://${host}:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, db };
