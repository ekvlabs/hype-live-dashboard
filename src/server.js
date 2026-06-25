import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { AnalyticsStore, clientIp } from "./analytics-store.js";
import { LiveDataService } from "./data-source.js";
import { apiCorsHeaders } from "./cors.js";
import { compactState, sseFrame } from "./events.js";
import { HistoryStore } from "./history-store.js";
import { TelegramAlertBot } from "./telegram-alert-bot.js";
import { twapDriverSignalEventsPayload } from "./twap-driver-research-events.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..");
const publicDir = join(rootDir, "public");
const vendorDir = join(rootDir, "node_modules", "lightweight-charts", "dist");
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";
const historyFile = process.env.HISTORY_FILE ?? join(rootDir, "data", "history.ndjson");
const analyticsFile = process.env.ANALYTICS_DB ?? join(rootDir, "data", "analytics.sqlite");
const maxHistoryHours = Number(process.env.MAX_HISTORY_HOURS ?? 336);
const memoryHistoryHours = Number(process.env.MEMORY_HISTORY_HOURS ?? 48);

const telegramBot = TelegramAlertBot.fromEnv(process.env);
const analyticsStore = new AnalyticsStore(analyticsFile);
const historyStore = new HistoryStore(historyFile);

const service = new LiveDataService({
  maxHistoryHours,
  memoryHistoryHours,
  historyStore,
  notifier: telegramBot,
});

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    trackRequest(req, res, url, startedAt);

    if (url.pathname.startsWith("/api/") && req.method === "OPTIONS") {
      res.writeHead(204, apiCorsHeaders());
      res.end();
      return;
    }

    if (url.pathname === "/api/snapshot") {
      sendJson(res, compactState(service.getState()));
      return;
    }

    if (url.pathname === "/api/history") {
      sendJson(
        res,
        await historyStore.payload({
          config: service.getState().config,
          options: historyQuery(url.searchParams),
        }),
      );
      return;
    }

    if (url.pathname === "/api/state") {
      sendJson(res, compactState(service.getState()));
      return;
    }

    if (url.pathname === "/api/visit") {
      sendJson(res, { ok: true });
      return;
    }

    if (url.pathname === "/api/analytics") {
      sendJson(res, {
        ...analyticsStore.summary(),
        bot: telegramBot.stats(),
      });
      return;
    }

    if (url.pathname === "/api/twap-driver/signals") {
      const query = signalEventQuery(url.searchParams);
      sendJson(
        res,
        twapDriverSignalEventsPayload({
          livePayload: telegramBot.signalEvents(query),
          history: service.getState().history,
          options: query,
        }),
      );
      return;
    }

    if (url.pathname === "/api/events") {
      handleEvents(req, res);
      return;
    }

    if (url.pathname === "/vendor/lightweight-charts.standalone.production.js") {
      await serveFile(join(vendorDir, "lightweight-charts.standalone.production.js"), res);
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, { error: "Internal server error" }, 500);
    } else {
      res.end();
    }
  }
});

await service.start().catch((error) => {
  console.error("Initial data fetch failed:", error.message);
});
telegramBot.start();

server.listen(port, host, () => {
  console.log(`HYPE live dashboard: http://${host}:${port}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

let isShuttingDown = false;

function trackRequest(req, res, url, startedAt) {
  res.on("finish", () => {
    try {
      analyticsStore.recordRequest({
        at: startedAt,
        method: req.method,
        path: url.pathname,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        ip: clientIp(req),
        userAgent: req.headers["user-agent"] ?? "",
      });
    } catch (error) {
      console.error("Analytics write failed:", error.message);
    }
  });
}

function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...apiCorsHeaders(),
  });

  const send = (event, payload) => {
    res.write(sseFrame(event, payload));
  };

  send("snapshot", compactState(service.getState()));
  const unsubscribe = service.subscribe(({ type, payload }) => {
    send(type, payload);
  });
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: {}\n\n`);
  }, 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function signalEventQuery(params) {
  return {
    limit: params.get("limit"),
    since: params.get("since"),
    status: params.get("status"),
  };
}

function historyQuery(params) {
  return {
    hours: params.get("hours"),
    resolutionSeconds: params.get("resolution"),
  };
}

async function serveStatic(pathname, res) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const normalizedPath = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, normalizedPath);

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, { error: "Not found" }, 404);
    return;
  }

  await serveFile(filePath, res);
}

async function serveFile(filePath, res) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      sendJson(res, { error: "Not found" }, 404);
      return;
    }
  } catch {
    sendJson(res, { error: "Not found" }, 404);
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...apiCorsHeaders(),
  });
  res.end(JSON.stringify(payload));
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function shutdown() {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  telegramBot.stop();
  service.stop();
  server.closeIdleConnections?.();

  const closeConnections = setTimeout(() => {
    server.closeAllConnections?.();
  }, 1_000);
  closeConnections.unref?.();

  const forceExit = setTimeout(() => {
    process.exit(0);
  }, 5_000);
  forceExit.unref?.();

  server.close(() => {
    clearTimeout(closeConnections);
    clearTimeout(forceExit);
    process.exit(0);
  });
}
