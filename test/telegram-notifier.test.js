import assert from "node:assert/strict";
import test from "node:test";

import { TelegramNotifier } from "../src/telegram-notifier.js";

test("TelegramNotifier sends threshold alerts with cooldown", async () => {
  const requests = [];
  const notifier = new TelegramNotifier({
    botToken: "token",
    chatId: "chat",
    twap1hThreshold: 100,
    cooldownMs: 60_000,
    fetchFn: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  await notifier.handleSnapshot({ timestamp: 1_000, pressure: { next1h: 150, next24h: 0 } });
  await notifier.handleSnapshot({ timestamp: 30_000, pressure: { next1h: 200, next24h: 0 } });
  await notifier.handleSnapshot({ timestamp: 61_000, pressure: { next1h: -150, next24h: 0 } });

  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /api\.telegram\.org\/bottoken\/sendMessage/);
  assert.equal(requests[0].body.chat_id, "chat");
  assert.match(requests[0].body.text, /TWAP 1h/);
  assert.match(requests[0].body.text, /\+150/);
  assert.match(requests[1].body.text, /-150/);
});

test("TelegramNotifier is disabled without token or chat", async () => {
  let calls = 0;
  const notifier = new TelegramNotifier({
    botToken: "",
    chatId: "chat",
    twap1hThreshold: 100,
    fetchFn: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });

  await notifier.handleSnapshot({ timestamp: 1_000, pressure: { next1h: 150, next24h: 0 } });

  assert.equal(calls, 0);
});
