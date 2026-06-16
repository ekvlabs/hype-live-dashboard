import assert from "node:assert/strict";
import test from "node:test";

import { historyPointLimit, trimHistory } from "../src/history.js";

test("historyPointLimit keeps 14 days at the one second polling interval", () => {
  assert.equal(historyPointLimit(1_000, 336), 1_209_600);
});

test("trimHistory keeps only the selected rolling time window", () => {
  const now = Date.UTC(2026, 5, 10, 12, 0, 0);
  const hour = 60 * 60_000;
  const history = [
    { t: now - 25 * hour, price: 1 },
    { t: now - 24 * hour, price: 2 },
    { t: now - 12 * hour, price: 3 },
    { t: now, price: 4 },
  ];

  assert.deepEqual(trimHistory(history, now, 24).map((point) => point.price), [2, 3, 4]);
  assert.deepEqual(trimHistory(history, now, 6).map((point) => point.price), [4]);
});
