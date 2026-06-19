import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { HistoryStore } from "../src/history-store.js";

test("HistoryStore persists points and loads only the rolling window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hype-history-"));
  try {
    const filePath = join(dir, "history.ndjson");
    const store = new HistoryStore(filePath);

    store.append({ t: 0, price: 50, next1h: 1, next24h: 2 });
    store.append({ t: 3_600_000, price: 51, next1h: 3, next24h: 4 });
    store.append({ t: 7_200_000, price: 52, next1h: 5, next24h: 6 });

    const loaded = store.load({ now: 7_200_000, maxHistoryHours: 1 });

    assert.deepEqual(loaded, [
      { t: 3_600_000, price: 51, next1h: 3, next24h: 4 },
      { t: 7_200_000, price: 52, next1h: 5, next24h: 6 },
    ]);
    assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HistoryStore preserves optional Hyperliquid perp fields without dropping legacy points", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hype-history-perp-"));
  try {
    const filePath = join(dir, "history.ndjson");
    const store = new HistoryStore(filePath);

    store.append({ t: 1_000, price: 50, next1h: 1, next24h: 2 });
    store.append({
      t: 2_000,
      price: 51,
      next1h: 3,
      next24h: 4,
      funding: "0.0000125",
      openInterest: "12345.67",
      premium: "-0.0002",
      markPx: "51.1",
      oraclePx: "51",
    });

    assert.deepEqual(store.load({ now: 2_000, maxHistoryHours: 1 }), [
      { t: 1_000, price: 50, next1h: 1, next24h: 2 },
      {
        t: 2_000,
        price: 51,
        next1h: 3,
        next24h: 4,
        funding: 0.0000125,
        openInterest: 12345.67,
        premium: -0.0002,
        markPx: 51.1,
        oraclePx: 51,
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HistoryStore default load keeps two weeks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hype-history-default-"));
  try {
    const filePath = join(dir, "history.ndjson");
    const store = new HistoryStore(filePath);
    const hour = 60 * 60_000;
    const now = 20 * 24 * hour;

    store.append({ t: now - 15 * 24 * hour, price: 49, next1h: 1, next24h: 2 });
    store.append({ t: now - 14 * 24 * hour, price: 50, next1h: 3, next24h: 4 });
    store.append({ t: now, price: 51, next1h: 5, next24h: 6 });

    assert.deepEqual(
      store.load({ now }).map((point) => point.price),
      [50, 51],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HistoryStore load avoids splitting the full history file into line arrays", async () => {
  const source = await readFile(new URL("../src/history-store.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\.split\(["'`]\\n["'`]\)/);
});
