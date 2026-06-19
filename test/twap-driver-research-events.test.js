import assert from "node:assert/strict";
import test from "node:test";

import {
  generateResearchTwapDriverEvents,
  twapDriverSignalEventsPayload,
} from "../src/twap-driver-research-events.js";

test("generateResearchTwapDriverEvents backfills TWAP_DRIVER entries from stored history", () => {
  const history = [
    historyPointAt(1_000, 100, 10_000, 10_000),
    historyPointAt(5 * 60_000 + 1_000, 100, 12_000, 20_000),
    historyPointAt(55 * 60_000 + 1_000, 100, 20_000, 80_000),
    historyPointAt(60 * 60_000 + 1_000, 100, 25_000, 95_000, 0),
  ];

  const events = generateResearchTwapDriverEvents(history);

  assert.deepEqual(
    events.map(({ source, kind, side, status, openedAt, entryPrice }) => ({
      source,
      kind,
      side,
      status,
      openedAt,
      entryPrice,
    })),
    [
      {
        source: "research",
        kind: "TWAP_DRIVER",
        side: "LONG",
        status: "OPEN",
        openedAt: 60 * 60_000 + 1_000,
        entryPrice: 100,
      },
    ],
  );
});

test("generateResearchTwapDriverEvents backfills PENDING_DRIVER when TWAP is strong after a chased move", () => {
  const history = [
    historyPointAt(1_000, 100, 10_000, 10_000),
    historyPointAt(5 * 60_000 + 1_000, 100, 12_000, 20_000),
    historyPointAt(55 * 60_000 + 1_000, 100.9, 20_000, 80_000),
    historyPointAt(60 * 60_000 + 1_000, 101, 25_000, 95_000, 0),
  ];

  const events = generateResearchTwapDriverEvents(history);

  assert.deepEqual(
    events.map(({ source, kind, side, status, phase, openedAt, entryPrice }) => ({
      source,
      kind,
      side,
      status,
      phase,
      openedAt,
      entryPrice,
    })),
    [
      {
        source: "research",
        kind: "PENDING_DRIVER",
        side: "LONG",
        status: "PENDING",
        phase: "PENDING",
        openedAt: 60 * 60_000 + 1_000,
        entryPrice: 101,
      },
    ],
  );
});

test("twapDriverSignalEventsPayload merges historical research events with live bot events", () => {
  const history = [
    historyPointAt(1_000, 100, 10_000, 10_000),
    historyPointAt(5 * 60_000 + 1_000, 100, 12_000, 20_000),
    historyPointAt(55 * 60_000 + 1_000, 100, 20_000, 80_000),
    historyPointAt(60 * 60_000 + 1_000, 100, 25_000, 95_000, 0),
  ];
  const livePayload = {
    items: [
      {
        id: "live:long",
        source: "live",
        kind: "TWAP_DRIVER",
        openedAt: 2 * 60 * 60_000,
        side: "LONG",
        entryPrice: 101,
        status: "OPEN",
      },
    ],
    stats: { total: 1 },
  };

  const payload = twapDriverSignalEventsPayload({ livePayload, history, options: { limit: 10 } });

  assert.equal(payload.items.length, 2);
  assert.deepEqual(
    payload.items.map(({ source, kind, openedAt }) => ({ source, kind, openedAt })),
    [
      { source: "live", kind: "TWAP_DRIVER", openedAt: 2 * 60 * 60_000 },
      { source: "research", kind: "TWAP_DRIVER", openedAt: 60 * 60_000 + 1_000 },
    ],
  );
  assert.deepEqual(payload.stats, {
    total: 1,
    researchTotal: 1,
    liveTotal: 1,
  });
});

function historyPointAt(t, price, q1, q24, premium = undefined) {
  const point = {
    t,
    price,
    next1h: q1 * price,
    next24h: q24 * price,
  };
  if (premium !== undefined) {
    point.premium = premium;
  }
  return point;
}
