-- Tetsa database layout. The backend creates data/tetsa.db from this file on first start.
-- Open data/tetsa.db with "DB Browser for SQLite" to look at the records.

-- One row per detected threat: what was seen, what the AI agent decided, and whether Telegram got it.
CREATE TABLE IF NOT EXISTS incidents (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT,               -- local time, YYYY-MM-DD HH:MM:SS
  camera  TEXT,
  label   TEXT,               -- Gun, Knife or Grenade
  conf    REAL,               -- detector confidence, 0 to 1
  status  TEXT,               -- Analysing, Alert or Safe
  risk    INTEGER,            -- 1 to 10, from the agent (or the rules if the agent was unavailable)
  summary TEXT,
  source  TEXT,               -- gemini, rules (unverified) or test
  notify  TEXT DEFAULT 'none',-- alert, low or none
  sent    INTEGER DEFAULT 1   -- 0 while a Telegram message is still waiting to go out
);

-- One row for every message Telegram accepted, with how many photos it carried.
-- Photos are in data/incidents/<incident_id>/ and are auto-deleted after RETAIN_DAYS; these rows stay.
CREATE TABLE IF NOT EXISTS telegram_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT,
  incident_id INTEGER,
  kind        TEXT,           -- alert or low
  photos      INTEGER
);
