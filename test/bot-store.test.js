import assert from "node:assert/strict";
import test from "node:test";

import { BotStore } from "../src/bot-store.js";

test("BotStore stores Telegram users and alert settings in SQLite", () => {
  const store = new BotStore(":memory:");
  store.upsertUser({
    chatId: 123,
    username: "trader",
    firstName: "Eva",
    now: 1_000,
  });

  assert.deepEqual(store.getUser(123), {
    chatId: 123,
    username: "trader",
    firstName: "Eva",
    threshold: 500_000,
    windowSeconds: 5,
    enabled: true,
    lastAlertAt: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  });

  store.setThreshold(123, 750_000, 2_000);
  store.setWindowSeconds(123, 15, 3_000);
  store.markAlertSent(123, 4_000);

  assert.equal(store.getUser(123).threshold, 750_000);
  assert.equal(store.getUser(123).windowSeconds, 15);
  assert.equal(store.getUser(123).lastAlertAt, 4_000);
  assert.deepEqual(store.listEnabledUsers().map((user) => user.chatId), [123]);

  store.disableUser(123, 5_000);
  assert.equal(store.getUser(123).enabled, false);
  assert.deepEqual(store.listEnabledUsers(), []);
});
