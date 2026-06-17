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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_signal_events (
        id TEXT PRIMARY KEY,
        opened_at INTEGER NOT NULL,
        side INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        move_bp REAL,
        net_taker_bp REAL,
        net_maker_bp REAL,
        closed_at INTEGER,
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

  recordSignalOpened({ id, openedAt, side, entryPrice, expiresAt }) {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO telegram_signal_events (
          id,
          opened_at,
          side,
          entry_price,
          expires_at,
          status,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'OPEN', ?)
      `)
      .run(id, Number(openedAt), Number(side), Number(entryPrice), Number(expiresAt), Number(openedAt));
  }

  recordSignalClosed({ id, outcome, moveBp, netTakerBp, netMakerBp, closedAt }) {
    this.db
      .prepare(`
        UPDATE telegram_signal_events
        SET
          status = ?,
          move_bp = ?,
          net_taker_bp = ?,
          net_maker_bp = ?,
          closed_at = ?,
          updated_at = ?
        WHERE id = ? AND status = 'OPEN'
      `)
      .run(
        String(outcome).toUpperCase(),
        Number(moveBp),
        Number(netTakerBp),
        Number(netMakerBp),
        Number(closedAt),
        Number(closedAt),
        id,
      );
  }

  listOpenSignals() {
    return this.db
      .prepare(`
        SELECT *
        FROM telegram_signal_events
        WHERE status = 'OPEN'
        ORDER BY opened_at
      `)
      .all()
      .map(mapSignalEvent);
  }

  listSignalEvents({ limit = 100, since = 0, status = "" } = {}) {
    const safeLimit = Math.min(250, Math.max(1, Number(limit) || 100));
    const safeSince = Math.max(0, Number(since) || 0);
    const safeStatus = String(status ?? "").trim().toUpperCase();
    const where = ["opened_at >= ?"];
    const values = [safeSince];
    if (["OPEN", "TP", "SL", "TIME"].includes(safeStatus)) {
      where.push("status = ?");
      values.push(safeStatus);
    }
    values.push(safeLimit);

    return this.db
      .prepare(`
        SELECT *
        FROM telegram_signal_events
        WHERE ${where.join(" AND ")}
        ORDER BY opened_at DESC
        LIMIT ?
      `)
      .all(...values)
      .map(mapPublicSignalEvent);
  }

  signalStats() {
    const row = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN status = 'TP' THEN 1 ELSE 0 END) AS tp,
          SUM(CASE WHEN status = 'SL' THEN 1 ELSE 0 END) AS sl,
          SUM(CASE WHEN status = 'TIME' THEN 1 ELSE 0 END) AS time,
          SUM(COALESCE(net_taker_bp, 0)) AS net_taker_bp,
          SUM(COALESCE(net_maker_bp, 0)) AS net_maker_bp
        FROM telegram_signal_events
      `)
      .get();
    return {
      total: Number(row?.total) || 0,
      open: Number(row?.open) || 0,
      tp: Number(row?.tp) || 0,
      sl: Number(row?.sl) || 0,
      time: Number(row?.time) || 0,
      netTakerBp: Number(row?.net_taker_bp) || 0,
      netMakerBp: Number(row?.net_maker_bp) || 0,
    };
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

function mapSignalEvent(row) {
  return {
    id: row.id,
    openedAt: Number(row.opened_at),
    side: Number(row.side),
    entryPrice: Number(row.entry_price),
    expiresAt: Number(row.expires_at),
  };
}

function mapPublicSignalEvent(row) {
  return {
    id: row.id,
    openedAt: Number(row.opened_at),
    side: Number(row.side) > 0 ? "LONG" : "SHORT",
    entryPrice: Number(row.entry_price),
    expiresAt: Number(row.expires_at),
    status: row.status,
    moveBp: nullableNumber(row.move_bp),
    netTakerBp: nullableNumber(row.net_taker_bp),
    netMakerBp: nullableNumber(row.net_maker_bp),
    closedAt: nullableNumber(row.closed_at),
    updatedAt: Number(row.updated_at),
  };
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}
