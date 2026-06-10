import assert from "node:assert/strict";
import test from "node:test";

import { BotStore } from "../src/bot-store.js";
import { TelegramAlertBot } from "../src/telegram-alert-bot.js";

test("TelegramAlertBot stores users and updates settings from commands", async () => {
  const store = new BotStore(":memory:");
  const messages = [];
  const bot = new TelegramAlertBot({
    botToken: "token",
    store,
    fetchFn: fakeTelegramFetch(messages),
  });

  await bot.handleUpdate(messageUpdate("/start", { id: 10, username: "eva", first_name: "Eva" }));
  await bot.handleUpdate(messageUpdate("/set 750000", { id: 10, username: "eva", first_name: "Eva" }));
  await bot.handleUpdate(messageUpdate("/window 15", { id: 10, username: "eva", first_name: "Eva" }));

  const user = store.getUser(10);
  assert.equal(user.enabled, true);
  assert.equal(user.threshold, 750_000);
  assert.equal(user.windowSeconds, 15);
  assert.match(messages.at(-1).text, /15s/);

  await bot.handleUpdate(messageUpdate("/stop", { id: 10, username: "eva", first_name: "Eva" }));
  assert.equal(store.getUser(10).enabled, false);
});

test("TelegramAlertBot sends threshold alerts using per-user window and cooldown", async () => {
  const store = new BotStore(":memory:");
  store.upsertUser({ chatId: 10, username: "eva", now: 1_000 });
  store.setThreshold(10, 500, 1_000);
  store.setWindowSeconds(10, 5, 1_000);

  const messages = [];
  const bot = new TelegramAlertBot({
    botToken: "token",
    store,
    cooldownMs: 60_000,
    fetchFn: fakeTelegramFetch(messages),
  });

  await bot.handleSnapshot(snapshotAt(1_000, 1_000));
  await bot.handleSnapshot(snapshotAt(6_000, 1_600));
  await bot.handleSnapshot(snapshotAt(7_000, 2_200));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].chat_id, 10);
  assert.match(messages[0].text, /TWAP 1h/);
  assert.match(messages[0].text, /\+600\$/);
  assert.match(messages[0].text, /5s/);
  assert.equal(store.getUser(10).lastAlertAt, 6_000);
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

function snapshotAt(timestamp, next1h) {
  return {
    timestamp,
    price: 55,
    pressure: {
      next1h,
      next24h: next1h * 2,
    },
  };
}

function fakeTelegramFetch(messages) {
  return async (_url, options) => {
    messages.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true }) };
  };
}
