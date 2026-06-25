import assert from "node:assert/strict";
import test from "node:test";

import {
  extractActiveAssetContext,
  HyperliquidAssetContextStream,
  normalizePerpAssetContext,
} from "../src/hyperliquid-asset-context.js";

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

test("HyperliquidAssetContextStream reconnects on websocket error without recursive close", () => {
  class MockWebSocket {
    static instances = [];

    constructor() {
      this.listeners = new Map();
      this.closeCalls = 0;
      MockWebSocket.instances.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    dispatch(type, event = {}) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }

    close() {
      this.closeCalls += 1;
      this.dispatch("error");
    }
  }

  const stream = new HyperliquidAssetContextStream({
    WebSocketImpl: MockWebSocket,
    reconnectMs: 60_000,
    now: () => 3000,
  });

  stream.start();
  const socket = MockWebSocket.instances[0];
  socket.dispatch("error");
  socket.dispatch("message", {
    data: JSON.stringify({
      channel: "activeAssetCtx",
      data: { coin: "HYPE", ctx: { markPx: "70", oraclePx: "69" } },
    }),
  });

  assert.equal(socket.closeCalls, 0);
  assert.equal(stream.latest(), null);

  stream.stop();
});
