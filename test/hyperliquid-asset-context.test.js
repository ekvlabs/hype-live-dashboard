import assert from "node:assert/strict";
import test from "node:test";

import { extractActiveAssetContext, normalizePerpAssetContext } from "../src/hyperliquid-asset-context.js";

test("normalizePerpAssetContext keeps numeric HYPE perp fields", () => {
  assert.deepEqual(
    normalizePerpAssetContext(
      {
        funding: "0.0000125",
        openInterest: "1234.5",
        premium: "-0.0002",
        markPx: "55.2",
        midPx: "55.1",
        oraclePx: "55",
        dayNtlVlm: "123456.7",
      },
      { coin: "HYPE", source: "ws", updatedAt: 1000 },
    ),
    {
      coin: "HYPE",
      funding: 0.0000125,
      openInterest: 1234.5,
      premium: -0.0002,
      markPx: 55.2,
      midPx: 55.1,
      oraclePx: 55,
      dayNtlVlm: 123456.7,
      source: "ws",
      updatedAt: 1000,
    },
  );
});

test("extractActiveAssetContext accepts activeAssetCtx websocket payloads", () => {
  const message = {
    channel: "activeAssetCtx",
    data: {
      coin: "HYPE",
      ctx: {
        funding: "0.00001",
        openInterest: "2000",
        premium: "0.0003",
        markPx: "56",
        oraclePx: "55.9",
      },
    },
  };

  assert.deepEqual(extractActiveAssetContext(message, { coin: "HYPE", updatedAt: 2000 }), {
    coin: "HYPE",
    funding: 0.00001,
    openInterest: 2000,
    premium: 0.0003,
    markPx: 56,
    oraclePx: 55.9,
    source: "ws",
    updatedAt: 2000,
  });
});
