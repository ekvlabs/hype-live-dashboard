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

test("BotStore reports aggregate user counts", () => {
  const store = new BotStore(":memory:");

  store.upsertUser({ chatId: 1, now: 1_000 });
  store.upsertUser({ chatId: 2, now: 1_000 });
  store.disableUser(2, 2_000);

  assert.deepEqual(store.stats(), {
    totalUsers: 2,
    enabledUsers: 1,
    disabledUsers: 1,
  });
});

test("BotStore persists TWAP_DRIVER signal events and stats", () => {
  const store = new BotStore(":memory:");

  store.recordSignalOpened({
    id: "sig-1",
    openedAt: 1_000,
    side: 1,
    entryPrice: 100,
    expiresAt: 2_000,
  });

  assert.deepEqual(store.signalStats(), {
    total: 1,
    open: 1,
    tp: 0,
    sl: 0,
    time: 0,
    netTakerBp: 0,
    netMakerBp: 0,
  });
  assert.deepEqual(store.listOpenSignals(), [
    {
      id: "sig-1",
      openedAt: 1_000,
      side: 1,
      entryPrice: 100,
      expiresAt: 2_000,
      hitCount: 1,
      lastHitAt: 1_000,
      lastNoticeAt: 1_000,
      mfeBp: 0,
      maeBp: 0,
      entryQ1: null,
      entryQ24: null,
      entryDq24: null,
      lastQ1: null,
      lastQ24: null,
      lastDq24: null,
      fadeNotifiedAt: 0,
      phase: "ACTIVE",
      phaseUpdatedAt: 1_000,
      tp1HitAt: 0,
      breakevenHitAt: 0,
      runnerStartedAt: 0,
      weakNotifiedAt: 0,
      trailStopBp: null,
      exitReason: "",
      lastAlignedAt: 1_000,
    },
  ]);

  store.recordSignalClosed({
    id: "sig-1",
    outcome: "TP",
    moveBp: 126,
    netTakerBp: 117,
    netMakerBp: 123,
    closedAt: 1_500,
  });

  assert.deepEqual(store.signalStats(), {
    total: 1,
    open: 0,
    tp: 1,
    sl: 0,
    time: 0,
    netTakerBp: 117,
    netMakerBp: 123,
  });
  assert.deepEqual(store.listOpenSignals(), []);
});

test("BotStore keeps PENDING_DRIVER events public but out of trade stats", () => {
  const store = new BotStore(":memory:");

  store.recordSignalOpened({
    id: "pending-1",
    openedAt: 1_000,
    side: 1,
    entryPrice: 100,
    expiresAt: 2_000,
    status: "PENDING",
    phase: "PENDING",
  });

  assert.deepEqual(store.signalStats(), {
    total: 0,
    open: 0,
    tp: 0,
    sl: 0,
    time: 0,
    netTakerBp: 0,
    netMakerBp: 0,
  });
  assert.deepEqual(store.listPendingSignals().map(({ id, phase, entryPrice }) => ({ id, phase, entryPrice })), [
    { id: "pending-1", phase: "PENDING", entryPrice: 100 },
  ]);
  assert.deepEqual(store.listSignalEvents({ status: "PENDING", limit: 10 }).map(({ id, status, phase }) => ({ id, status, phase })), [
    { id: "pending-1", status: "PENDING", phase: "PENDING" },
  ]);

  store.recordPendingClosed({
    id: "pending-1",
    outcome: "CANCELLED",
    closedAt: 1_500,
    exitReason: "PENDING_TIMEOUT",
  });

  assert.deepEqual(store.listPendingSignals(), []);
  assert.deepEqual(
    store.listSignalEvents({ limit: 10 }).map(({ id, status, phase, exitReason, moveBp }) => ({ id, status, phase, exitReason, moveBp })),
    [{ id: "pending-1", status: "CANCELLED", phase: "FINAL_EXIT", exitReason: "PENDING_TIMEOUT", moveBp: 0 }],
  );
  assert.equal(store.signalStats().total, 0);
});

test("BotStore lists sanitized TWAP_DRIVER signal events for public charts", () => {
  const store = new BotStore(":memory:");
  store.upsertUser({ chatId: 123, username: "private_user", firstName: "Private", now: 500 });

  store.recordSignalOpened({
    id: "sig-old",
    openedAt: 500,
    side: -1,
    entryPrice: 99,
    expiresAt: 1_500,
  });
  store.recordSignalOpened({
    id: "sig-open",
    openedAt: 1_000,
    side: 1,
    entryPrice: 100,
    expiresAt: 2_000,
  });
  store.recordSignalOpened({
    id: "sig-closed",
    openedAt: 3_000,
    side: -1,
    entryPrice: 105,
    expiresAt: 4_000,
  });
  store.recordSignalClosed({
    id: "sig-closed",
    outcome: "SL",
    moveBp: -20,
    netTakerBp: -29,
    netMakerBp: -23,
    closedAt: 3_500,
  });

  assert.deepEqual(store.listSignalEvents({ since: 1_000, limit: 10 }), [
    {
      id: "sig-closed",
      openedAt: 3_000,
      side: "SHORT",
      entryPrice: 105,
      expiresAt: 4_000,
      status: "SL",
      moveBp: -20,
      netTakerBp: -29,
      netMakerBp: -23,
      closedAt: 3_500,
      updatedAt: 3_500,
      hitCount: 1,
      lastHitAt: 3_000,
      lastNoticeAt: 3_000,
      mfeBp: 0,
      maeBp: 0,
      phase: "FINAL_EXIT",
      tp1HitAt: 0,
      breakevenHitAt: 0,
      runnerStartedAt: 0,
      weakNotifiedAt: 0,
      fadeNotifiedAt: 0,
      trailStopBp: null,
      exitReason: "",
    },
    {
      id: "sig-open",
      openedAt: 1_000,
      side: "LONG",
      entryPrice: 100,
      expiresAt: 2_000,
      status: "OPEN",
      moveBp: null,
      netTakerBp: null,
      netMakerBp: null,
      closedAt: null,
      updatedAt: 1_000,
      hitCount: 1,
      lastHitAt: 1_000,
      lastNoticeAt: 1_000,
      mfeBp: 0,
      maeBp: 0,
      phase: "ACTIVE",
      tp1HitAt: 0,
      breakevenHitAt: 0,
      runnerStartedAt: 0,
      weakNotifiedAt: 0,
      fadeNotifiedAt: 0,
      trailStopBp: null,
      exitReason: "",
    },
  ]);
  assert.deepEqual(store.listSignalEvents({ status: "OPEN", limit: 1 }).map((event) => event.id), ["sig-open"]);
  assert.equal("chatId" in store.listSignalEvents({ limit: 1 })[0], false);
  assert.equal("username" in store.listSignalEvents({ limit: 1 })[0], false);
});

test("BotStore stores TWAP_DRIVER regime lifecycle metrics", () => {
  const store = new BotStore(":memory:");

  store.recordSignalOpened({
    id: "regime-1",
    openedAt: 1_000,
    side: 1,
    entryPrice: 100,
    expiresAt: 10_000,
    entryQ1: 25_000,
    entryQ24: 95_000,
    entryDq24: 85_000,
    lastNoticeAt: 1_000,
  });
  store.recordSignalProgress({
    id: "regime-1",
    hitCount: 2,
    lastHitAt: 2_000,
    lastNoticeAt: 2_000,
    mfeBp: 42,
    maeBp: -8,
    lastQ1: 40_000,
    lastQ24: 170_000,
    lastDq24: 140_000,
    phase: "TP1",
    phaseUpdatedAt: 2_500,
    tp1HitAt: 2_500,
    breakevenHitAt: 2_200,
    runnerStartedAt: 2_500,
    trailStopBp: 75,
    lastAlignedAt: 2_500,
  });

  assert.deepEqual(store.listOpenSignals(), [
    {
      id: "regime-1",
      openedAt: 1_000,
      side: 1,
      entryPrice: 100,
      expiresAt: 10_000,
      hitCount: 2,
      lastHitAt: 2_000,
      lastNoticeAt: 2_000,
      mfeBp: 42,
      maeBp: -8,
      entryQ1: 25_000,
      entryQ24: 95_000,
      entryDq24: 85_000,
      lastQ1: 40_000,
      lastQ24: 170_000,
      lastDq24: 140_000,
      fadeNotifiedAt: 0,
      phase: "TP1",
      phaseUpdatedAt: 2_500,
      tp1HitAt: 2_500,
      breakevenHitAt: 2_200,
      runnerStartedAt: 2_500,
      weakNotifiedAt: 0,
      trailStopBp: 75,
      exitReason: "",
      lastAlignedAt: 2_500,
    },
  ]);
  assert.deepEqual(store.listSignalEvents({ limit: 1 }), [
    {
      id: "regime-1",
      openedAt: 1_000,
      side: "LONG",
      entryPrice: 100,
      expiresAt: 10_000,
      status: "OPEN",
      moveBp: null,
      netTakerBp: null,
      netMakerBp: null,
      closedAt: null,
      updatedAt: 2_500,
      hitCount: 2,
      lastHitAt: 2_000,
      lastNoticeAt: 2_000,
      mfeBp: 42,
      maeBp: -8,
      phase: "TP1",
      tp1HitAt: 2_500,
      breakevenHitAt: 2_200,
      runnerStartedAt: 2_500,
      weakNotifiedAt: 0,
      fadeNotifiedAt: 0,
      trailStopBp: 75,
      exitReason: "",
    },
  ]);

  store.recordSignalClosed({
    id: "regime-1",
    outcome: "TP",
    moveBp: 67,
    netTakerBp: 58,
    netMakerBp: 64,
    closedAt: 3_000,
    exitReason: "TRAIL",
  });

  assert.deepEqual(store.listSignalEvents({ limit: 1 }).map(({ status, exitReason, moveBp }) => ({ status, exitReason, moveBp })), [
    { status: "TP", exitReason: "TRAIL", moveBp: 67 },
  ]);
});
