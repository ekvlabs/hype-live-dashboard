import assert from "node:assert/strict";
import test from "node:test";

import { LiveDataService } from "../src/data-source.js";

test("LiveDataService samples TWAP, price, and Hyperliquid perp values into history", () => {
  const service = new LiveDataService({ intervalMs: 1_000 });
  service.snapshot = {
    timestamp: 100,
    price: 55.1,
    pressure: {
      next1h: 10,
      next24h: 20,
      total: { buy: 0, sell: 0, net: 0 },
    },
    perp: {
      funding: 0.00001,
      openInterest: 1000,
      premium: -0.0002,
      markPx: 55.2,
      oraclePx: 55.0,
    },
  };

  service.sampleHistory(1_000);
  service.snapshot = {
    timestamp: 200,
    price: 55.2,
    pressure: {
      next1h: -5,
      next24h: 25,
      total: { buy: 0, sell: 0, net: 0 },
    },
    perp: {
      funding: -0.00002,
      openInterest: 1100,
      premium: 0.0003,
      markPx: 55.3,
      oraclePx: 55.1,
    },
  };
  service.sampleHistory(2_000);

  assert.deepEqual(service.getState().history, [
    {
      t: 1_000,
      price: 55.1,
      next1h: 10,
      next24h: 20,
      funding: 0.00001,
      openInterest: 1000,
      premium: -0.0002,
      markPx: 55.2,
      oraclePx: 55,
    },
    {
      t: 2_000,
      price: 55.2,
      next1h: -5,
      next24h: 25,
      funding: -0.00002,
      openInterest: 1100,
      premium: 0.0003,
      markPx: 55.3,
      oraclePx: 55.1,
    },
  ]);
});

test("LiveDataService keeps one week of one-second history by default", () => {
  const service = new LiveDataService({ intervalMs: 1_000 });

  assert.equal(service.getState().config.maxHistoryHours, 168);
  assert.equal(service.getState().config.historyLimit, 604_800);
});
