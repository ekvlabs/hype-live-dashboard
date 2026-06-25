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

test("LiveDataService keeps two weeks of one-second history by default", () => {
  const service = new LiveDataService({ intervalMs: 1_000 });

  assert.equal(service.getState().config.maxHistoryHours, 336);
  assert.equal(service.getState().config.historyLimit, 1_209_600);
});

test("LiveDataService can keep a shorter in-memory history window than disk retention", () => {
  const service = new LiveDataService({
    intervalMs: 1_000,
    maxHistoryHours: 336,
    memoryHistoryHours: 1,
  });

  assert.equal(service.getState().config.maxHistoryHours, 336);
  assert.equal(service.getState().config.memoryHistoryHours, 1);
  assert.equal(service.getState().config.memoryHistoryLimit, 3_600);

  service.snapshot = {
    timestamp: 100,
    price: 55,
    pressure: {
      next1h: 10,
      next24h: 20,
      total: { buy: 0, sell: 0, net: 0 },
    },
  };

  service.sampleHistory(0);
  service.sampleHistory(60 * 60_000);
  service.sampleHistory(2 * 60 * 60_000);

  assert.deepEqual(
    service.getState().history.map((point) => point.t),
    [60 * 60_000, 2 * 60 * 60_000],
  );
});

test("LiveDataService does not compact disk history from a shorter memory window", () => {
  let replaced = false;
  const service = new LiveDataService({
    intervalMs: 1_000,
    maxHistoryHours: 336,
    memoryHistoryHours: 1,
    historyCompactMs: 1,
    historyStore: {
      append() {},
      replace() {
        replaced = true;
      },
    },
  });

  service.snapshot = {
    timestamp: 100,
    price: 55,
    pressure: {
      next1h: 10,
      next24h: 20,
      total: { buy: 0, sell: 0, net: 0 },
    },
  };

  service.sampleHistory(Date.now() + 2);

  assert.equal(replaced, false);
});

test("LiveDataService seeds notifier with stored history", () => {
  const storedHistory = [{ t: 1_000, price: 55, next1h: 10, next24h: 20 }];
  let seededHistory = null;
  const service = new LiveDataService({
    historyStore: {
      load: () => storedHistory,
    },
    notifier: {
      seedHistory(history) {
        seededHistory = history;
      },
    },
  });

  service.loadStoredHistory(2_000);

  assert.deepEqual(seededHistory, storedHistory);
});

test("LiveDataService keeps retrying after the initial refresh fails", async () => {
  let calls = 0;
  const service = new LiveDataService({
    intervalMs: 5,
    assetContextStream: { start() {}, stop() {} },
  });
  service.fetchSnapshot = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("temporary upstream failure");
    }
    return {
      timestamp: 2_000,
      price: 55.2,
      pressure: {
        next1h: 10,
        next24h: 20,
        total: { buy: 20, sell: 0, net: 20 },
      },
      summary: {},
      activeTwaps: 1,
      activeHypeTwaps: 1,
      hypeMarkets: [],
    };
  };

  await service.start();
  try {
    await waitFor(() => service.getState().snapshot);
    assert.equal(service.getState().status.ok, true);
    assert.equal(service.getState().snapshot.price, 55.2);
    assert.equal(calls >= 2, true);
  } finally {
    service.stop();
  }
});

async function waitFor(predicate, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}
