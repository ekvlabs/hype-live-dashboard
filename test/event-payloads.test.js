import assert from "node:assert/strict";
import test from "node:test";

import { compactState, historyPointEvent } from "../src/events.js";

test("compactState excludes full history from SSE snapshot payloads", () => {
  const state = {
    snapshot: { price: 55 },
    status: { ok: true },
    config: { intervalMs: 1_000 },
    history: [{ t: 1, price: 55, next1h: 10, next24h: 20 }],
  };

  assert.deepEqual(compactState(state), {
    snapshot: { price: 55 },
    status: { ok: true },
    config: { intervalMs: 1_000 },
  });
});

test("historyPointEvent carries exactly one sampled point", () => {
  const point = { t: 1_000, price: 55.1, next1h: 10, next24h: 20 };

  assert.deepEqual(historyPointEvent(point), {
    point,
  });
});

test("server exposes compact live state separately from full history snapshots", async () => {
  const serverSource = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
  );

  assert.match(serverSource, /url\.pathname === "\/api\/state"/);
  assert.match(serverSource, /url\.pathname === "\/api\/visit"/);
  assert.match(serverSource, /sendJson\(res, compactState\(service\.getState\(\)\)\)/);
});

test("server exposes sanitized TWAP_DRIVER signal events for charts", async () => {
  const serverSource = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
  );

  assert.match(serverSource, /url\.pathname === "\/api\/twap-driver\/signals"/);
  assert.match(serverSource, /telegramBot\.signalEvents/);
  assert.doesNotMatch(serverSource, /telegram_users/);
});
