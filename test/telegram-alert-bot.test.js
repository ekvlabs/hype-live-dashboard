import assert from "node:assert/strict";
import test from "node:test";

import { BotStore } from "../src/bot-store.js";
import { TelegramAlertBot } from "../src/telegram-alert-bot.js";

test("TelegramAlertBot stores users and controls TWAP_DRIVER subscriptions", async () => {
  const store = new BotStore(":memory:");
  const messages = [];
  const bot = new TelegramAlertBot({
    botToken: "token",
    store,
    fetchFn: fakeTelegramFetch(messages),
  });

  await bot.handleUpdate(messageUpdate("/start", { id: 10, username: "eva", first_name: "Eva" }));
  await bot.handleUpdate(messageUpdate("/status", { id: 10, username: "eva", first_name: "Eva" }));
  await bot.handleUpdate(messageUpdate("/signal", { id: 10, username: "eva", first_name: "Eva" }));

  const user = store.getUser(10);
  assert.equal(user.enabled, true);
  assert.match(messages[0].text, /TWAP_DRIVER/);
  assert.match(messages[1].text, /Alerts enabled/);
  assert.match(messages[2].text, /80,000 HYPE/);

  await bot.handleUpdate(messageUpdate("/stop", { id: 10, username: "eva", first_name: "Eva" }));
  assert.equal(store.getUser(10).enabled, false);
});

test("TelegramAlertBot sends only TWAP_DRIVER alerts", async () => {
  const store = new BotStore(":memory:");
  store.upsertUser({ chatId: 10, username: "eva", now: 1_000 });

  const messages = [];
  const bot = new TelegramAlertBot({
    botToken: "token",
    store,
    cooldownMs: 30 * 60 * 1_000,
    fetchFn: fakeTelegramFetch(messages),
  });

  await bot.handleSnapshot(snapshotAt(1_000, { price: 100, q1: 10_000, q24: 10_000 }));
  await bot.handleSnapshot(snapshotAt(6_000, { price: 100, q1: 25_000, q24: 10_100 }));
  assert.equal(messages.length, 0);

  await bot.handleSnapshot(snapshotAt(5 * 60_000 + 1_000, { price: 100, q1: 20_000, q24: 30_000 }));
  await bot.handleSnapshot(snapshotAt(60 * 60_000 + 1_000, { price: 100, q1: 25_000, q24: 95_000, premium: 0 }));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].chat_id, 10);
  assert.match(messages[0].text, /TWAP_DRIVER LONG/);
  assert.match(messages[0].text, /Δq24 60m: \+85,000 HYPE/);
  assert.match(messages[0].text, /SL 20bp \/ TP 126bp \/ max hold 45m/);
  assert.equal(store.getUser(10).lastAlertAt, 60 * 60_000 + 1_000);
});

test("TelegramAlertBot tracks TWAP_DRIVER execution stats", async () => {
  const store = new BotStore(":memory:");
  store.upsertUser({ chatId: 10, username: "eva", now: 1_000 });

  const messages = [];
  const bot = new TelegramAlertBot({
    botToken: "token",
    store,
    cooldownMs: 30 * 60 * 1_000,
    fetchFn: fakeTelegramFetch(messages),
  });

  await bot.handleSnapshot(snapshotAt(1_000, { price: 100, q1: 10_000, q24: 10_000 }));
  await bot.handleSnapshot(snapshotAt(5 * 60_000 + 1_000, { price: 100, q1: 20_000, q24: 30_000 }));
  await bot.handleSnapshot(snapshotAt(60 * 60_000 + 1_000, { price: 100, q1: 25_000, q24: 95_000, premium: 0 }));
  await bot.handleSnapshot(snapshotAt(61 * 60_000 + 1_000, { price: 101.3, q1: 25_000, q24: 95_000, premium: 0 }));

  await bot.handleUpdate(messageUpdate("/status", { id: 10, username: "eva", first_name: "Eva" }));

  assert.match(messages.at(-1).text, /Signals: 1/);
  assert.match(messages.at(-1).text, /TP: 1/);
  assert.match(messages.at(-1).text, /Net taker: \+117bp/);
});

test("TelegramAlertBot aborts in-flight polling when stopped", async () => {
  const store = new BotStore(":memory:");
  let signalSeen = false;
  let aborted = false;
  const bot = new TelegramAlertBot({
    botToken: "token",
    store,
    fetchFn: (_url, options) => {
      signalSeen = Boolean(options.signal);
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ ok: false, status: 499 });
        });
      });
    },
  });

  const polling = bot.pollUpdates();
  await Promise.resolve();
  bot.stop();

  assert.equal(await polling, false);
  assert.equal(signalSeen, true);
  assert.equal(aborted, true);
});

test("server shutdown has a bounded forced close path", async () => {
  const serverSource = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
  );

  assert.match(serverSource, /closeAllConnections/);
  assert.match(serverSource, /setTimeout/);
});

function messageUpdate(text, from) {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    message: {
      text,
      chat: { id: from.id },
      from,
    },
  };
}

function snapshotAt(timestamp, { price = 100, q1 = 0, q24 = 0, premium = 0 } = {}) {
  return {
    timestamp,
    price,
    pressure: {
      next1h: q1 * price,
      next24h: q24 * price,
    },
    perp: {
      premium,
    },
  };
}

function fakeTelegramFetch(messages) {
  return async (_url, options) => {
    messages.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true }) };
  };
}
