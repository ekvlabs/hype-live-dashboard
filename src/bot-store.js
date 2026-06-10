import { DatabaseSync } from "node:sqlite";

const DEFAULT_THRESHOLD = 500_000;
const DEFAULT_WINDOW_SECONDS = 5;

export class BotStore {
  constructor(filePath = ":memory:") {
    this.db = new DatabaseSync(filePath);
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_users (
        chat_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        threshold REAL NOT NULL DEFAULT ${DEFAULT_THRESHOLD},
        window_seconds INTEGER NOT NULL DEFAULT ${DEFAULT_WINDOW_SECONDS},
        enabled INTEGER NOT NULL DEFAULT 1,
        last_alert_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  upsertUser({ chatId, username = "", firstName = "", now = Date.now() }) {
    this.db
      .prepare(`
        INSERT INTO telegram_users (
          chat_id,
          username,
          first_name,
          threshold,
          window_seconds,
          enabled,
          last_alert_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name,
          enabled = 1,
          updated_at = excluded.updated_at
      `)
      .run(chatId, username, firstName, DEFAULT_THRESHOLD, DEFAULT_WINDOW_SECONDS, now, now);
  }

  getUser(chatId) {
    const row = this.db.prepare("SELECT * FROM telegram_users WHERE chat_id = ?").get(chatId);
    return row ? mapUser(row) : null;
  }

  listEnabledUsers() {
    return this.db.prepare("SELECT * FROM telegram_users WHERE enabled = 1 ORDER BY chat_id").all().map(mapUser);
  }

  stats() {
    const row = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total_users,
          SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled_users
        FROM telegram_users
      `)
      .get();
    const totalUsers = Number(row?.total_users) || 0;
    const enabledUsers = Number(row?.enabled_users) || 0;
    return {
      totalUsers,
      enabledUsers,
      disabledUsers: totalUsers - enabledUsers,
    };
  }

  setThreshold(chatId, threshold, now = Date.now()) {
    this.db
      .prepare("UPDATE telegram_users SET threshold = ?, updated_at = ? WHERE chat_id = ?")
      .run(Number(threshold), now, chatId);
  }

  setWindowSeconds(chatId, windowSeconds, now = Date.now()) {
    this.db
      .prepare("UPDATE telegram_users SET window_seconds = ?, updated_at = ? WHERE chat_id = ?")
      .run(Number(windowSeconds), now, chatId);
  }

  markAlertSent(chatId, now = Date.now()) {
    this.db
      .prepare("UPDATE telegram_users SET last_alert_at = ?, updated_at = ? WHERE chat_id = ?")
      .run(now, now, chatId);
  }

  disableUser(chatId, now = Date.now()) {
    this.db
      .prepare("UPDATE telegram_users SET enabled = 0, updated_at = ? WHERE chat_id = ?")
      .run(now, chatId);
  }
}

function mapUser(row) {
  return {
    chatId: Number(row.chat_id),
    username: row.username ?? "",
    firstName: row.first_name ?? "",
    threshold: Number(row.threshold),
    windowSeconds: Number(row.window_seconds),
    enabled: Boolean(row.enabled),
    lastAlertAt: Number(row.last_alert_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
