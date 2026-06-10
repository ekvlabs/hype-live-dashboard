import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class AnalyticsStore {
  constructor(filePath = ":memory:") {
    this.filePath = filePath;
    if (filePath !== ":memory:") {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        visitor_key TEXT NOT NULL,
        user_agent TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_request_events_at ON request_events(at);
      CREATE INDEX IF NOT EXISTS idx_request_events_kind_at ON request_events(kind, at);
    `);
  }

  recordRequest({
    at = Date.now(),
    method = "GET",
    path = "/",
    statusCode = 0,
    durationMs = 0,
    ip = "",
    userAgent = "",
  } = {}) {
    const normalizedPath = normalizePath(path);
    this.db
      .prepare(`
        INSERT INTO request_events (
          at,
          method,
          path,
          kind,
          status_code,
          duration_ms,
          visitor_key,
          user_agent
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        Number(at) || Date.now(),
        String(method || "GET").slice(0, 16),
        normalizedPath,
        classifyRequestPath(normalizedPath),
        Number(statusCode) || 0,
        Math.max(0, Number(durationMs) || 0),
        visitorKey(ip, userAgent),
        String(userAgent || "").slice(0, 256),
      );
  }

  summary({ now = Date.now() } = {}) {
    return {
      generatedAt: now,
      windows: {
        day: this.windowSummary(now - 24 * 60 * 60 * 1000),
        week: this.windowSummary(now - 7 * 24 * 60 * 60 * 1000),
        all: this.windowSummary(null),
      },
    };
  }

  windowSummary(fromAt) {
    const page = this.kindSummary("page", fromAt);
    const api = this.kindSummary("api", fromAt);
    const all = this.allSummary(fromAt);
    return {
      site: {
        pageViews: page.requests,
        uniqueVisitors: page.uniqueVisitors,
      },
      api: {
        requests: api.requests,
        uniqueClients: api.uniqueVisitors,
      },
      totalRequests: all.requests,
      uniqueClients: all.uniqueVisitors,
    };
  }

  kindSummary(kind, fromAt) {
    const where = fromAt === null ? "kind = ?" : "kind = ? AND at >= ?";
    const params = fromAt === null ? [kind] : [kind, Number(fromAt)];
    return mapSummary(this.db.prepare(summarySql(where)).get(...params));
  }

  allSummary(fromAt) {
    const where = fromAt === null ? "kind IN ('page', 'api', 'asset')" : "kind IN ('page', 'api', 'asset') AND at >= ?";
    const params = fromAt === null ? [] : [Number(fromAt)];
    return mapSummary(this.db.prepare(summarySql(where)).get(...params));
  }
}

export function classifyRequestPath(pathname) {
  const path = normalizePath(pathname);
  if (path === "/" || path === "/index.html" || path === "/api/visit") {
    return "page";
  }
  if (path === "/api/analytics") {
    return "analytics";
  }
  if (path.startsWith("/api/")) {
    return "api";
  }
  return "asset";
}

export function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "";
}

function normalizePath(path) {
  const value = String(path || "/").split("?")[0] || "/";
  return value.startsWith("/") ? value : `/${value}`;
}

function visitorKey(ip, userAgent) {
  return createHash("sha256")
    .update(`${String(ip || "")}\n${String(userAgent || "")}`)
    .digest("hex");
}

function summarySql(where) {
  return `
    SELECT
      COUNT(*) AS requests,
      COUNT(DISTINCT visitor_key) AS unique_visitors
    FROM request_events
    WHERE ${where}
  `;
}

function mapSummary(row) {
  return {
    requests: Number(row?.requests) || 0,
    uniqueVisitors: Number(row?.unique_visitors) || 0,
  };
}
