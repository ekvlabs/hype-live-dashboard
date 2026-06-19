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
    this.ensureSignalColumn("hit_count", "INTEGER NOT NULL DEFAULT 1");
    this.ensureSignalColumn("last_hit_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureSignalColumn("last_notice_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureSignalColumn("mfe_bp", "REAL NOT NULL DEFAULT 0");
    this.ensureSignalColumn("mae_bp", "REAL NOT NULL DEFAULT 0");
    this.ensureSignalColumn("entry_q1", "REAL");
    this.ensureSignalColumn("entry_q24", "REAL");
    this.ensureSignalColumn("entry_dq24", "REAL");
    this.ensureSignalColumn("last_q1", "REAL");
    this.ensureSignalColumn("last_q24", "REAL");
    this.ensureSignalColumn("last_dq24", "REAL");
    this.ensureSignalColumn("fade_notified_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureSignalColumn("phase", "TEXT NOT NULL DEFAULT 'ACTIVE'");
    this.ensureSignalColumn("phase_updated_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureSignalColumn("tp1_hit_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureSignalColumn("breakeven_hit_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureSignalColumn("runner_started_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureSignalColumn("weak_notified_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureSignalColumn("trail_stop_bp", "REAL");
    this.ensureSignalColumn("exit_reason", "TEXT NOT NULL DEFAULT ''");
    this.ensureSignalColumn("last_aligned_at", "INTEGER NOT NULL DEFAULT 0");
  }

  ensureSignalColumn(name, definition) {
    const columns = this.db.prepare("PRAGMA table_info(telegram_signal_events)").all();
    if (columns.some((column) => column.name === name)) {
      return;
    }
    this.db.exec(`ALTER TABLE telegram_signal_events ADD COLUMN ${name} ${definition}`);
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

  recordSignalOpened({
    id,
    openedAt,
    side,
    entryPrice,
    expiresAt,
    status = "OPEN",
    entryQ1 = null,
    entryQ24 = null,
    entryDq24 = null,
    lastNoticeAt = openedAt,
    phase = "ACTIVE",
    phaseUpdatedAt = openedAt,
    lastAlignedAt = openedAt,
  }) {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO telegram_signal_events (
          id,
          opened_at,
          side,
          entry_price,
          expires_at,
          status,
          hit_count,
          last_hit_at,
          last_notice_at,
          mfe_bp,
          mae_bp,
          entry_q1,
          entry_q24,
          entry_dq24,
          last_q1,
          last_q24,
          last_dq24,
          fade_notified_at,
          phase,
          phase_updated_at,
          tp1_hit_at,
          breakeven_hit_at,
          runner_started_at,
          weak_notified_at,
          trail_stop_bp,
          exit_reason,
          last_aligned_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, 0, 0, NULL, '', ?, ?)
      `)
      .run(
        id,
        Number(openedAt),
        Number(side),
        Number(entryPrice),
        Number(expiresAt),
        String(status || "OPEN").toUpperCase(),
        Number(openedAt),
        Number(lastNoticeAt),
        nullableSqlNumber(entryQ1),
        nullableSqlNumber(entryQ24),
        nullableSqlNumber(entryDq24),
        nullableSqlNumber(entryQ1),
        nullableSqlNumber(entryQ24),
        nullableSqlNumber(entryDq24),
        String(phase || "ACTIVE"),
        Number(phaseUpdatedAt),
        Number(lastAlignedAt),
        Number(openedAt),
      );
  }

  recordSignalProgress({
    id,
    hitCount = null,
    lastHitAt = null,
    lastNoticeAt = null,
    mfeBp = null,
    maeBp = null,
    lastQ1 = null,
    lastQ24 = null,
    lastDq24 = null,
    fadeNotifiedAt = null,
    phase = null,
    phaseUpdatedAt = null,
    tp1HitAt = null,
    breakevenHitAt = null,
    runnerStartedAt = null,
    weakNotifiedAt = null,
    trailStopBp = null,
    exitReason = null,
    lastAlignedAt = null,
  }) {
    const updatedAt =
      Math.max(
        Number(lastHitAt) || 0,
        Number(lastNoticeAt) || 0,
        Number(fadeNotifiedAt) || 0,
        Number(phaseUpdatedAt) || 0,
        Number(tp1HitAt) || 0,
        Number(breakevenHitAt) || 0,
        Number(runnerStartedAt) || 0,
        Number(weakNotifiedAt) || 0,
        Number(lastAlignedAt) || 0,
      ) || Date.now();
    this.db
      .prepare(`
        UPDATE telegram_signal_events
        SET
          hit_count = COALESCE(?, hit_count),
          last_hit_at = COALESCE(?, last_hit_at),
          last_notice_at = COALESCE(?, last_notice_at),
          mfe_bp = COALESCE(?, mfe_bp),
          mae_bp = COALESCE(?, mae_bp),
          last_q1 = COALESCE(?, last_q1),
          last_q24 = COALESCE(?, last_q24),
          last_dq24 = COALESCE(?, last_dq24),
          fade_notified_at = COALESCE(?, fade_notified_at),
          phase = COALESCE(?, phase),
          phase_updated_at = COALESCE(?, phase_updated_at),
          tp1_hit_at = COALESCE(?, tp1_hit_at),
          breakeven_hit_at = COALESCE(?, breakeven_hit_at),
          runner_started_at = COALESCE(?, runner_started_at),
          weak_notified_at = COALESCE(?, weak_notified_at),
          trail_stop_bp = COALESCE(?, trail_stop_bp),
          exit_reason = COALESCE(?, exit_reason),
          last_aligned_at = COALESCE(?, last_aligned_at),
          updated_at = ?
        WHERE id = ? AND status = 'OPEN'
      `)
      .run(
        nullableSqlNumber(hitCount),
        nullableSqlNumber(lastHitAt),
        nullableSqlNumber(lastNoticeAt),
        nullableSqlNumber(mfeBp),
        nullableSqlNumber(maeBp),
        nullableSqlNumber(lastQ1),
        nullableSqlNumber(lastQ24),
        nullableSqlNumber(lastDq24),
        nullableSqlNumber(fadeNotifiedAt),
        nullableSqlText(phase),
        nullableSqlNumber(phaseUpdatedAt),
        nullableSqlNumber(tp1HitAt),
        nullableSqlNumber(breakevenHitAt),
        nullableSqlNumber(runnerStartedAt),
        nullableSqlNumber(weakNotifiedAt),
        nullableSqlNumber(trailStopBp),
        nullableSqlText(exitReason),
        nullableSqlNumber(lastAlignedAt),
        updatedAt,
        id,
      );
  }

  recordSignalClosed({ id, outcome, moveBp, netTakerBp, netMakerBp, closedAt, exitReason = "" }) {
    this.db
      .prepare(`
        UPDATE telegram_signal_events
        SET
          status = ?,
          move_bp = ?,
          net_taker_bp = ?,
          net_maker_bp = ?,
          closed_at = ?,
          phase = 'FINAL_EXIT',
          phase_updated_at = ?,
          exit_reason = ?,
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
        String(exitReason || ""),
        Number(closedAt),
        id,
      );
  }

  recordPendingClosed({ id, outcome, closedAt, exitReason = "" }) {
    this.db
      .prepare(`
        UPDATE telegram_signal_events
        SET
          status = ?,
          move_bp = 0,
          net_taker_bp = 0,
          net_maker_bp = 0,
          closed_at = ?,
          phase = 'FINAL_EXIT',
          phase_updated_at = ?,
          exit_reason = ?,
          updated_at = ?
        WHERE id = ? AND status = 'PENDING'
      `)
      .run(String(outcome).toUpperCase(), Number(closedAt), Number(closedAt), String(exitReason || ""), Number(closedAt), id);
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

  listPendingSignals() {
    return this.db
      .prepare(`
        SELECT *
        FROM telegram_signal_events
        WHERE status = 'PENDING'
        ORDER BY opened_at
      `)
      .all()
      .map(mapSignalEvent);
  }

  listSignalEvents({ limit = 100, since = 0, status = "" } = {}) {
    const safeLimit = Math.min(2_000, Math.max(1, Number(limit) || 100));
    const safeSince = Math.max(0, Number(since) || 0);
    const safeStatus = String(status ?? "").trim().toUpperCase();
    const where = ["opened_at >= ?"];
    const values = [safeSince];
    if (["OPEN", "TP", "SL", "TIME", "OPPOSITE", "PENDING", "CONVERTED", "CANCELLED"].includes(safeStatus)) {
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
        WHERE status IN ('OPEN', 'TP', 'SL', 'TIME', 'OPPOSITE')
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
    hitCount: Number(row.hit_count) || 1,
    lastHitAt: Number(row.last_hit_at) || Number(row.opened_at),
    lastNoticeAt: Number(row.last_notice_at) || Number(row.opened_at),
    mfeBp: Number(row.mfe_bp) || 0,
    maeBp: Number(row.mae_bp) || 0,
    entryQ1: nullableNumber(row.entry_q1),
    entryQ24: nullableNumber(row.entry_q24),
    entryDq24: nullableNumber(row.entry_dq24),
    lastQ1: nullableNumber(row.last_q1),
    lastQ24: nullableNumber(row.last_q24),
    lastDq24: nullableNumber(row.last_dq24),
    fadeNotifiedAt: Number(row.fade_notified_at) || 0,
    phase: row.phase || "ACTIVE",
    phaseUpdatedAt: Number(row.phase_updated_at) || Number(row.opened_at),
    tp1HitAt: Number(row.tp1_hit_at) || 0,
    breakevenHitAt: Number(row.breakeven_hit_at) || 0,
    runnerStartedAt: Number(row.runner_started_at) || 0,
    weakNotifiedAt: Number(row.weak_notified_at) || 0,
    trailStopBp: nullableNumber(row.trail_stop_bp),
    exitReason: row.exit_reason || "",
    lastAlignedAt: Number(row.last_aligned_at) || Number(row.opened_at),
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
    hitCount: Number(row.hit_count) || 1,
    lastHitAt: Number(row.last_hit_at) || Number(row.opened_at),
    lastNoticeAt: Number(row.last_notice_at) || Number(row.opened_at),
    mfeBp: Number(row.mfe_bp) || 0,
    maeBp: Number(row.mae_bp) || 0,
    phase: row.phase || "ACTIVE",
    tp1HitAt: Number(row.tp1_hit_at) || 0,
    breakevenHitAt: Number(row.breakeven_hit_at) || 0,
    runnerStartedAt: Number(row.runner_started_at) || 0,
    weakNotifiedAt: Number(row.weak_notified_at) || 0,
    fadeNotifiedAt: Number(row.fade_notified_at) || 0,
    trailStopBp: nullableNumber(row.trail_stop_bp),
    exitReason: row.exit_reason || "",
  };
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function nullableSqlNumber(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
}

function nullableSqlText(value) {
  return value === null || value === undefined ? null : String(value);
}
