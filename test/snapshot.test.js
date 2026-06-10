import assert from "node:assert/strict";
import test from "node:test";

import { createSnapshot } from "../src/snapshot.js";

test("createSnapshot combines TWAP pressure, HYPE price, and summary", () => {
  const now = Date.UTC(2026, 5, 10, 4, 0, 0);
  const spotMeta = {
    tokens: [
      { index: 0, name: "USDC" },
      { index: 150, name: "HYPE" },
    ],
    universe: [{ index: 107, name: "@107", tokens: [150, 0] }],
  };
  const spotContexts = [];
  spotContexts[107] = { midPx: "50" };
  const perpMeta = { universe: [] };
  perpMeta.universe[159] = { name: "HYPE" };
  const perpContexts = [];
  perpContexts[159] = { midPx: "51" };
  const candles = [
    { t: now - 60_000, o: "49", h: "50", l: "48.5", c: "49.5", v: "10" },
    { t: now, o: "49.5", h: "52", l: "49", c: "51.25", v: "12" },
  ];
  const twaps = [
    {
      time: now,
      hash: "buy",
      action: { twap: { a: 10107, b: true, s: "20", m: 60 } },
    },
    {
      time: now,
      hash: "sell",
      action: { twap: { a: 10107, b: false, s: "5", m: 120 } },
    },
  ];

  const snapshot = createSnapshot({
    twaps,
    spotMeta,
    spotContexts,
    perpMeta,
    perpContexts,
    candles,
    allMids: { HYPE: "49" },
    widgetSettings: {
      twapWatch: { marketType: "all", pressureMode: "total", pressureAssets: ["HYPE"] },
      priceChart: { coins: ["HYPE"], timeframe: "1m" },
    },
    now,
  });

  assert.equal(snapshot.timestamp, now);
  assert.equal(snapshot.price, 50);
  assert.equal(snapshot.priceSource, "spot @107");
  assert.deepEqual(snapshot.priceCandles, [
    { t: now - 60_000, open: 49, high: 50, low: 48.5, close: 49.5, volume: 10 },
    { t: now, open: 49.5, high: 52, low: 49, close: 51.25, volume: 12 },
  ]);
  assert.equal(snapshot.pressure.next1h, 875);
  assert.equal(snapshot.pressure.next24h, 750);
  assert.equal(snapshot.pressure.total.buy, 1000);
  assert.equal(snapshot.pressure.total.sell, 250);
  assert.equal(snapshot.pressure.total.net, 750);
  assert.equal(snapshot.summary.buyCount, 1);
  assert.equal(snapshot.summary.sellCount, 1);
  assert.equal(snapshot.activeHypeTwaps, 2);
});
