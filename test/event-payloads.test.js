import assert from "node:assert/strict";
import test from "node:test";

import { compactState, historyPayload, historyPointEvent } from "../src/events.js";

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

test("historyPayload returns a bounded requested window with effective resolution", () => {
  const hour = 60 * 60_000;
  const state = {
    config: { intervalMs: 1_000, maxHistoryHours: 336 },
    history: [
      { t: 0, price: 10, next1h: 1, next24h: 2 },
      { t: hour, price: 11, next1h: 3, next24h: 4 },
      { t: hour + 1_000, price: 12, next1h: 5, next24h: 6 },
      { t: 2 * hour, price: 13, next1h: 7, next24h: 8 },
    ],
  };

  assert.deepEqual(historyPayload(state, { hours: 1, resolutionSeconds: 1, maxPoints: 2 }), {
    history: [
      { t: hour + 1_000, price: 12, next1h: 5, next24h: 6 },
      { t: 2 * hour, price: 13, next1h: 7, next24h: 8 },
    ],
    config: {
      intervalMs: 1_000,
      maxHistoryHours: 336,
      historyResolutionSeconds: 1800,
      historyHours: 1,
      historyPoints: 2,
    },
  });
});

test("historyPayload rounds effective resolution to readable chart steps", () => {
  const hour = 60 * 60_000;
  const state = {
    config: { intervalMs: 1_000, maxHistoryHours: 336 },
    history: [
      { t: 0, price: 10, next1h: 1, next24h: 2 },
      { t: 336 * hour, price: 11, next1h: 3, next24h: 4 },
    ],
  };

  assert.equal(
    historyPayload(state, { hours: 336, resolutionSeconds: 1, maxPoints: 100_000 }).config
      .historyResolutionSeconds,
    15,
  );
});

test("historyPayload defaults long chart windows to a memory-safe response size", () => {
  const hour = 60 * 60_000;
  const state = {
    config: { intervalMs: 1_000, maxHistoryHours: 336 },
    history: [
      { t: 0, price: 10, next1h: 1, next24h: 2 },
      { t: 336 * hour, price: 11, next1h: 3, next24h: 4 },
    ],
  };

  assert.equal(historyPayload(state, { hours: 336, resolutionSeconds: 1 }).config.historyResolutionSeconds, 60);
});

test("server exposes compact live state separately from full history snapshots", async () => {
  const serverSource = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
  );

  assert.match(serverSource, /url\.pathname === "\/api\/state"/);
  assert.match(serverSource, /url\.pathname === "\/api\/history"/);
  assert.match(serverSource, /url\.pathname === "\/api\/visit"/);
  assert.match(serverSource, /sendJson\(res, compactState\(service\.getState\(\)\)\)/);
  assert.match(serverSource, /sendJson\(res, historyPayload\(service\.getState\(\), historyQuery\(url\.searchParams\)\)\)/);
});

test("server exposes sanitized TWAP_DRIVER signal events for charts", async () => {
  const serverSource = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
  );

  assert.match(serverSource, /url\.pathname === "\/api\/twap-driver\/signals"/);
  assert.match(serverSource, /telegramBot\.signalEvents/);
  assert.doesNotMatch(serverSource, /telegram_users/);
});
