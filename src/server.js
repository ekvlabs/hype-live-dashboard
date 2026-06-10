import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { LiveDataService } from "./data-source.js";
import { apiCorsHeaders } from "./cors.js";
import { compactState, sseFrame } from "./events.js";
import { HistoryStore } from "./history-store.js";
import { TelegramAlertBot } from "./telegram-alert-bot.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..");
const publicDir = join(rootDir, "public");
const vendorDir = join(rootDir, "node_modules", "lightweight-charts", "dist");
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";
const historyFile = process.env.HISTORY_FILE ?? join(rootDir, "data", "history.ndjson");

const telegramBot = TelegramAlertBot.fromEnv(process.env);

const service = new LiveDataService({
  historyStore: new HistoryStore(historyFile),
  notifier: telegramBot,
});

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname.startsWith("/api/") && req.method === "OPTIONS") {
      res.writeHead(204, apiCorsHeaders());
      res.end();
      return;
    }

    if (url.pathname === "/api/snapshot") {
      sendJson(res, service.getState());
      return;
    }

    if (url.pathname === "/api/state") {
      sendJson(res, compactState(service.getState()));
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
