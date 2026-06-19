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
  assert.match(messages[0].text, /https:\/\/ekvlabs.github.io\/hype-live-dashboard\//);
  assert.match(messages[1].text, /Alerts enabled/);
  assert.match(messages[2].text, /80,000 HYPE/);
  assert.match(messages[2].text, /https:\/\/ekvlabs.github.io\/hype-live-dashboard\//);

  await bot.handleUpdate(messageUpdate("/stop", { id: 10, username: "eva", first_name: "Eva" }));
  assert.equal(store.getUser(10).enabled, false);
  assert.match(messages.at(-1).text, /https:\/\/ekvlabs.github.io\/hype-live-dashboard\//);

  await bot.handleUpdate(messageUpdate("/set 100000", { id: 10, username: "eva", first_name: "Eva" }));
  assert.match(messages.at(-1).text, /https:\/\/ekvlabs.github.io\/hype-live-dashboard\//);
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
  assert.match(messages[0].text, /TWAP_DRIVER ENTRY LONG/);
  assert.match(messages[0].text, /Entry: \$100\.00/);
  assert.match(messages[0].text, /Δq24 60m: \+85,000 HYPE/);
  assert.match(messages[0].text, /hard SL 20bp/);
  assert.match(messages[0].text, /TP1 \+50bp/);
  assert.match(messages[0].text, /https:\/\/ekvlabs.github.io\/hype-live-dashboard\//);
  assert.equal(store.getUser(10).lastAlertAt, 60 * 60_000 + 1_000);
});

test("TelegramAlertBot stores PENDING_DRIVER when TWAP pressure is valid but price is chased", async () => {
  const store = new BotStore(":memory:");
  store.upsertUser({ chatId: 10, username: "eva", now: 1_000 });

  const messages = [];
  const bot = new TelegramAlertBot({
    botToken: "token",
    store,
    cooldownMs: 1,
    fetchFn: fakeTelegramFetch(messages),
  });

  await bot.handleSnapshot(snapshotAt(1_000, { price: 100, q1: 10_000, q24: 10_000 }));
  await bot.handleSnapshot(snapshotAt(5 * 60_000 + 1_000, { price: 100, q1: 12_000, q24: 10_000 }));
  await bot.handleSnapshot(snapshotAt(55 * 60_000 + 1_000, { price: 101, q1: 20_000, q24: 80_000 }));
  await bot.handleSnapshot(snapshotAt(60 * 60_000 + 1_000, { price: 101, q1: 25_000, q24: 95_000, premium: 0 }));

  assert.equal(messages.length, 0);
  assert.deepEqual(
    store.listSignalEvents({ limit: 5 }).map(({ side, status, phase, entryPrice }) => ({ side, status, phase, entryPrice })),
    [{ side: "LONG", status: "PENDING", phase: "PENDING", entryPrice: 101 }],
  );
});

test("TelegramAlertBot converts PENDING_DRIVER to ENTRY after short-term price cools while pressure remains aligned", async () => {
  const store = new BotStore(":memory:");
  store.upsertUser({ chatId: 10, username: "eva", now: 1_000 });

  const messages = [];
  const bot = new TelegramAlertBot({
    botToken: "token",
    store,
    cooldownMs: 1,
    fetchFn: fakeTelegramFetch(messages),
  });

  await bot.handleSnapshot(snapshotAt(1_000, { price: 100, q1: 10_000, q24: 10_000 }));
  await bot.handleSnapshot(snapshotAt(5 * 60_000 + 1_000, { price: 100, q1: 12_000, q24: 10_000 }));
  await bot.handleSnapshot(snapshotAt(55 * 60_000 + 1_000, { price: 101, q1: 20_000, q24: 80_000 }));
  await bot.handleSnapshot(snapshotAt(60 * 60_000 + 1_000, { price: 101, q1: 25_000, q24: 95_000, premium: 0 }));
  await bot.handleSnapshot(snapshotAt(65 * 60_000 + 2_000, { price: 101.02, q1: 26_000, q24: 100_000, premium: 0 }));

  assert.equal(messages.filter((message) => /TWAP_DRIVER ENTRY LONG/.test(message.text)).length, 1);
  assert.match(messages.at(-1).text, /Entry: \$101\.02/);
  assert.deepEqual(
    store.listSignalEvents({ limit: 5 }).map(({ side, status, phase, entryPrice }) => ({ side, status, phase, entryPrice })),
    [
      { side: "LONG", status: "OPEN", phase: "ACTIVE", entryPrice: 101.02 },
      { side: "LONG", status: "CONVERTED", phase: "FINAL_EXIT", entryPrice: 101 },
    ],
  );
});

test("TelegramAlertBot cancels stale PENDING_DRIVER without sending a trade alert", async () => {
  const store = new BotStore(":memory:");
  store.upsertUser({ chatId: 10, username: "eva", now: 1_000 });

  const messages = [];
  const bot = new TelegramAlertBot({
    botToken: "token",
    store,
    cooldownMs: 1,
    fetchFn: fakeTelegramFetch(messages),
  });

  await bot.handleSnapshot(snapshotAt(1_000, { price: 100, q1: 10_000, q24: 10_000 }));
  await bot.handleSnapshot(snapshotAt(5 * 60_000 + 1_000, { price: 100, q1: 12_000, q24: 10_000 }));
  await bot.handleSnapshot(snapshotAt(55 * 60_000 + 1_000, { price: 101, q1: 20_000, q24: 80_000 }));
  await bot.handleSnapshot(snapshotAt(60 * 60_000 + 1_000, { price: 101, q1: 25_000, q24: 95_000, premium: 0 }));
  await bot.handleSnapshot(snapshotAt(71 * 60_000 + 2_000, { price: 101.5, q1: 1_000, q24: 30_000, premium: 0 }));

  assert.equal(messages.length, 0);
  assert.deepEqual(
    store.listSignalEvents({ limit: 5 }).map(({ side, status, phase, exitReason }) => ({ side, status, phase, exitReason })),
    [{ side: "LONG", status: "CANCELLED", phase: "FINAL_EXIT", exitReason: "PENDING_TIMEOUT" }],
  );
});

test("TelegramAlertBot treats repeated same-side TWAP_DRIVER hits as one managed regime", async () => {
  const store = new BotStore(":memory:");
  store.upsertUser({ chatId: 10, username: "eva", now: 1_000 });

  const messages = [];
  const bot = new TelegramAlertBot({
    botToken: "token",
    store,
    cooldownMs: 1,
    fetchFn: fakeTelegramFetch(messages),
  });

  await bot.handleSnapshot(snapshotAt(1_000, { price: 100, q1: 10_000, q24: 10_000 }));
  await bot.handleSnapshot(snapshotAt(5 * 60_000 + 1_000, { price: 100, q1: 20_000, q24: 30_000 }));
  await bot.handleSnapshot(snapshotAt(60 * 60_000 + 1_000, { price: 100, q1: 25_000, q24: 95_000, premium: 0 }));
  await bot.handleSnapshot(snapshotAt(65 * 60_000 + 1_000, { price: 100.25, q1: 25_000, q24: 95_000, premium: 0 }));
  await bot.handleSnapshot(snapshotAt(70 * 60_000 + 1_000, { price: 100.05, q1: 40_000, q24: 170_000, premium: 0 }));
  await bot.handleSnapshot(snapshotAt(71 * 60_000 + 1_000, { price: 100.06, q1: 41_000, q24: 172_000, premium: 0 }));

  assert.equal(messages.filter((message) => /TWAP_DRIVER ENTRY LONG/.test(message.text)).length, 1);
  assert.equal(messages.filter((message) => /TWAP_DRIVER EXTEND LONG/.test(message.text)).length, 1);
  assert.equal(store.signalStats().total, 1);
  assert.equal(store.listOpenSignals()[0].hitCount, 3);

  await bot.handleSnapshot(snapshotAt(72 * 60_000 + 1_000, { price: 101.3, q1: 41_000, q24: 172_000, premium: 0 }));

  assert.equal(messages.filter((message) => /TWAP_DRIVER TP1 LONG/.test(message.text)).length, 1);
  assert.equal(messages.filter((message) => /TWAP_DRIVER EXIT LONG - TP/.test(message.text)).length, 0);
  assert.deepEqual(
    store.listSignalEvents({ limit: 1 }).map(({ status, phase, hitCount, mfeBp, maeBp }) => ({
      status,
      phase,
      hitCount,
      mfeBp,
      maeBp,
    })),
    [{ status: "OPEN", phase: "TP1", hitCount: 3, mfeBp: 130, maeBp: 0 }],
  );
});

test("TelegramAlertBot keeps runner open after TP1 and closes after pressure fade timeout", async () => {
  const store = new BotStore(":memory:");
  store.upsertUser({ chatId: 10, username: "eva", now: 1_000 });

  const messages = [];
  const bot = new TelegramAlertBot({
    botToken: "token",
    store,
    cooldownMs: 1,
    fetchFn: fakeTelegramFetch(messages),
  });

  await bot.handleSnapshot(snapshotAt(1_000, { price: 100, q1: 10_000, q24: 10_000 }));
  await bot.handleSnapshot(snapshotAt(5 * 60_000 + 1_000, { price: 100, q1: 20_000, q24: 30_000 }));
  await bot.handleSnapshot(snapshotAt(60 * 60_000 + 1_000, { price: 100, q1: 25_000, q24: 95_000, premium: 0 }));
  await bot.handleSnapshot(snapshotAt(65 * 60_000 + 1_000, { price: 100.6, q1: 30_000, q24: 110_000, premium: 0 }));
  await bot.handleSnapshot(snapshotAt(70 * 60_000 + 1_000, { price: 101.8, q1: 30_000, q24: 110_000, premium: 0 }));
  await bot.handleSnapshot(snapshotAt(80 * 60_000 + 1_000, { price: 101.4, q1: 5_000, q24: 35_000, premium: 0 }));
  await bot.handleSnapshot(snapshotAt(96 * 60_000 + 1_000, { price: 101.2, q1: 5_000, q24: 35_000, premium: 0 }));

  assert.equal(messages.filter((message) => /TWAP_DRIVER ENTRY LONG/.test(message.text)).length, 1);
  assert.equal(messages.filter((message) => /TWAP_DRIVER TP1 LONG/.test(message.text)).length, 1);
  assert.equal(messages.filter((message) => /TWAP_DRIVER FADE LONG/.test(message.text)).length, 1);
  assert.equal(messages.filter((message) => /TWAP_DRIVER EXIT LONG - TP/.test(message.text)).length, 1);
  assert.match(messages.at(-1).text, /Reason: FADE_TIMEOUT/);
  assert.deepEqual(
    store.listSignalEvents({ limit: 1 }).map(({ status, phase, exitReason, moveBp, mfeBp, maeBp }) => ({
      status,
      phase,
      exitReason,
      moveBp,
      mfeBp,
      maeBp,
    })),
    [{ status: "TP", phase: "FINAL_EXIT", exitReason: "FADE_TIMEOUT", moveBp: 120, mfeBp: 180, maeBp: 0 }],
  );
});

test("TelegramAlertBot closes weak TWAP_DRIVER regimes that never develop MFE", async () => {
  const store = new BotStore(":memory:");
  store.upsertUser({ chatId: 10, username: "eva", now: 1_000 });

  const messages = [];
  const bot = new TelegramAlertBot({
    botToken: "token",
    store,
    cooldownMs: 1,
    fetchFn: fakeTelegramFetch(messages),
  });

  await bot.handleSnapshot(snapshotAt(1_000, { price: 100, q1: 10_000, q24: 10_000 }));
  await bot.handleSnapshot(snapshotAt(5 * 60_000 + 1_000, { price: 100, q1: 20_000, q24: 30_000 }));
  await bot.handleSnapshot(snapshotAt(60 * 60_000 + 1_000, { price: 100, q1: 25_000, q24: 95_000, premium: 0 }));
  await bot.handleSnapshot(snapshotAt(71 * 60_000 + 1_000, { price: 100.1, q1: 25_000, q24: 95_000, premium: 0 }));

  assert.equal(messages.filter((message) => /TWAP_DRIVER ENTRY LONG/.test(message.text)).length, 1);
  assert.equal(messages.filter((message) => /TWAP_DRIVER EXIT LONG - TIME/.test(message.text)).length, 1);
  assert.match(messages.at(-1).text, /Reason: WEAK_TIMEOUT/);
  assert.deepEqual(
    store.listSignalEvents({ limit: 1 }).map(({ status, phase, exitReason, moveBp, mfeBp, maeBp }) => ({
      status,
      phase,
      exitReason,
      moveBp,
      mfeBp,
      maeBp,
    })),
    [{ status: "TIME", phase: "FINAL_EXIT", exitReason: "WEAK_TIMEOUT", moveBp: 10, mfeBp: 10, maeBp: 0 }],
  );
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
  await bot.handleSnapshot(snapshotAt(61 * 60_000 + 1_000, { price: 99.75, q1: 25_000, q24: 95_000, premium: 0 }));

  await bot.handleUpdate(messageUpdate("/status", { id: 10, username: "eva", first_name: "Eva" }));

  assert.match(messages.at(-1).text, /Signals: 1/);
  assert.match(messages.at(-1).text, /SL: 1/);
  assert.match(messages.at(-1).text, /Net taker: -29bp/);
});

test("TelegramAlertBot persists TWAP_DRIVER execution stats across bot restarts", async () => {
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

  const restartedBot = new TelegramAlertBot({
    botToken: "token",
    store,
    cooldownMs: 30 * 60 * 1_000,
    fetchFn: fakeTelegramFetch(messages),
  });
  await restartedBot.handleSnapshot(snapshotAt(61 * 60_000 + 1_000, { price: 99.75, q1: 25_000, q24: 95_000, premium: 0 }));
  await restartedBot.handleUpdate(messageUpdate("/status", { id: 10, username: "eva", first_name: "Eva" }));

  assert.match(messages.at(-1).text, /Signals: 1/);
  assert.match(messages.at(-1).text, /Open: 0/);
  assert.match(messages.at(-1).text, /SL: 1/);
  assert.match(messages.at(-1).text, /Net taker: -29bp/);
});

test("TelegramAlertBot seeds only the history needed for TWAP_DRIVER", () => {
  const bot = new TelegramAlertBot({
    botToken: "token",
    store: new BotStore(":memory:"),
  });

  bot.seedHistory([
    historyPointAt(1_000, 100, 1_000, 1_000),
    historyPointAt(2 * 60 * 60_000, 100, 2_000, 2_000),
  ]);

  assert.deepEqual(
    bot.samples.map((sample) => sample.t),
    [1_000, 2 * 60 * 60_000],
  );
});

function historyPointAt(t, price, q1, q24) {
  return {
    t,
    price,
    next1h: q1 * price,
    next24h: q24 * price,
  };
}

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
