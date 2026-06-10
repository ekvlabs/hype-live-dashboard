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
