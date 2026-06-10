import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMarketState,
  calculateHypePressure,
  calculateTwapPressureTotal,
  calculateTwapValue,
  getHypePrice,
  getActiveTwaps,
} from "../src/pressure.js";

const now = Date.UTC(2026, 5, 10, 4, 0, 0);

const spotMeta = {
  tokens: [
    { index: 0, name: "USDC" },
    { index: 150, name: "HYPE" },
    { index: 151, name: "OTHER" },
  ],
  universe: [
    { index: 107, name: "@107", tokens: [150, 0] },
    { index: 108, name: "@108", tokens: [151, 0] },
  ],
};

const spotContexts = [];
spotContexts[107] = { midPx: "56.25", markPx: "56.20" };
spotContexts[108] = { midPx: "2.5", markPx: "2.4" };

const perpMeta = {
  universe: [
    { name: "BTC" },
    { name: "ETH" },
  ],
};

perpMeta.universe[159] = { name: "HYPE" };

const perpContexts = [];
perpContexts[159] = { midPx: "55.5", markPx: "55.4" };

test("buildMarketState maps spot market IDs and finds HYPE markets", () => {
  const state = buildMarketState(spotMeta, spotContexts, { "@107": "56.30" });

  assert.equal(state.marketsById.get(10107).token, "HYPE");
  assert.equal(state.marketsById.get(10107).price, 56.25);
  assert.equal(state.marketsById.get(10108).token, "OTHER");
  assert.deepEqual(state.hypeMarketIds, [10107]);
});

test("buildMarketState includes HYPE perp and spot markets when marketType is all", () => {
  const state = buildMarketState({
    spotMeta,
    spotContexts,
    perpMeta,
    perpContexts,
    allMids: { HYPE: "55.6" },
    marketType: "all",
  });

  assert.equal(state.marketsById.get(159).token, "HYPE");
  assert.equal(state.marketsById.get(159).type, "perp");
  assert.equal(state.marketsById.get(159).price, 55.5);
  assert.deepEqual(state.hypeMarketIds, [159, 10107]);
});

test("calculateTwapValue uses market price and size", () => {
  const state = buildMarketState(spotMeta, spotContexts, {});
  const twap = {
    action: { twap: { a: 10107, s: "10" } },
  };

  assert.equal(calculateTwapValue(twap, state), 562.5);
});

test("getActiveTwaps excludes ended and expired TWAPs", () => {
  const state = buildMarketState(spotMeta, spotContexts, {});
  const twaps = [
    makeTwap({ hash: "active", marketId: 10107, minutes: 120, size: "10", time: now - 30 * 60_000 }),
    makeTwap({ hash: "ended", marketId: 10107, minutes: 120, size: "10", time: now - 30 * 60_000, ended: "filled" }),
    makeTwap({ hash: "expired", marketId: 10107, minutes: 15, size: "10", time: now - 30 * 60_000 }),
    makeTwap({ hash: "unknown-price", marketId: 19999, minutes: 120, size: "10", time: now - 30 * 60_000 }),
  ];

  const active = getActiveTwaps(twaps, state, now);

  assert.deepEqual(active.map((twap) => twap.hash), ["active"]);
  assert.equal(active[0].value, 562.5);
});

test("calculateHypePressure matches HypurrScan overlap formula", () => {
  const state = buildMarketState(spotMeta, spotContexts, {});
  const twaps = [
    makeTwap({ marketId: 10107, isBuy: true, minutes: 120, size: "10", time: now - 30 * 60_000 }),
    makeTwap({ marketId: 10107, isBuy: false, minutes: 240, size: "8", time: now - 60 * 60_000 }),
    makeTwap({ marketId: 10108, isBuy: true, minutes: 240, size: "999", time: now }),
  ];

  const active = getActiveTwaps(twaps, state, now);
  const pressure = calculateHypePressure(active, state.hypeMarketIds, now);

  assert.equal(Math.round(pressure.next1h * 1e6) / 1e6, 168.75);
  assert.equal(Math.round(pressure.next24h * 1e6) / 1e6, 84.375);
});

test("calculateTwapPressureTotal returns remaining total pressure for widget total mode", () => {
  const state = buildMarketState({
    spotMeta,
    spotContexts,
    perpMeta,
    perpContexts,
    marketType: "all",
  });
  const twaps = [
    makeTwap({ marketId: 159, isBuy: true, minutes: 120, size: "10", time: now - 30 * 60_000 }),
    makeTwap({ marketId: 10107, isBuy: false, minutes: 240, size: "8", time: now - 60 * 60_000 }),
    makeTwap({ marketId: 10108, isBuy: true, minutes: 240, size: "999", time: now }),
  ];

  const active = getActiveTwaps(twaps, state, now);
  const pressure = calculateTwapPressureTotal(active, state.hypeMarketIds, now);

  assert.equal(round6(pressure.buy), 416.25);
  assert.equal(round6(pressure.sell), 337.5);
  assert.equal(round6(pressure.net), 78.75);
});

test("getHypePrice prefers HYPE/USDC spot over perp fallback", () => {
  const state = buildMarketState(spotMeta, spotContexts, { HYPE: "55.1" });

  assert.deepEqual(getHypePrice(state, { HYPE: "55.1" }), {
    price: 56.25,
    source: "spot @107",
  });
});

function makeTwap({
  hash = Math.random().toString(16).slice(2),
  marketId,
  isBuy = true,
  minutes,
  size,
  time,
  ended,
}) {
  return {
    time,
    hash,
    ended,
    action: {
      type: "twapOrder",
      twap: {
        a: marketId,
        b: isBuy,
        s: size,
        m: minutes,
      },
    },
  };
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}
