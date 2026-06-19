import assert from "node:assert/strict";
import test from "node:test";

import {
  NEGATIVE_TWAP_COLOR,
  driverEventsToMarkers,
  driverEventsToCompactMarkers,
  historyToAlignedRegimeBars,
  historyToAlignedLineData,
  historyToAlignedPriceBars,
  historyToLineData,
  historyToPriceBars,
  minimumBarSpacingForRange,
  needsVerticalAutoscale,
  nextLiveVisibleRange,
  normalizedHistory,
  pruneSeriesData,
  requiredHistoryHoursForDriverEvents,
  selectedHistoryWindow,
  shouldFollowLiveRange,
  shouldKeepLiveFollowing,
  upsertAlignedRegimeBarData,
  upsertLineDataPoint,
  upsertAlignedLineDataPoint,
  upsertAlignedPriceBarData,
  upsertPriceBarData,
  visibleTimeRangeForDriverEvents,
  visibleDataRange,
} from "../public/chart-data.js";

test("normalizedHistory keeps one raw point per second with saved chart values", () => {
  const history = normalizedHistory([
    { t: 1_000, next1h: "10", next24h: "20", price: "55.1" },
    {
      t: 1_900,
      next1h: "11",
      next24h: "21",
      price: "55.2",
      funding: "0.00001",
      openInterest: "12",
      driverRegime: "1",
    },
    { t: 2_000, next1h: "-5", next24h: "30", price: "55.3", driverRegime: "-1" },
  ]);

  assert.deepEqual(history, [
    { time: 1, next1h: 11, next24h: 21, price: 55.2, funding: 0.00001, openInterest: 12, driverRegime: 1 },
    { time: 2, next1h: -5, next24h: 30, price: 55.3, driverRegime: -1 },
  ]);
});

test("TWAP_DRIVER regime bars and markers align to the shared time axis", () => {
  const history = [
    { time: 10, price: 100, driverRegime: 1 },
    { time: 11, price: 101, driverRegime: 1 },
    { time: 15, price: 102, driverRegime: -1 },
    { time: 16, price: 103 },
    { time: 20, price: 104 },
  ];

  assert.deepEqual(historyToAlignedRegimeBars(history, 5), [
    { time: 10, value: 1, color: "#10b437" },
    { time: 15, value: -1, color: "#e34b4b" },
    { time: 20, value: 0, color: "rgba(69, 211, 195, 0.18)" },
  ]);
  assert.deepEqual(
    history.reduce((data, point) => upsertAlignedRegimeBarData(data, point, 5), []),
    [
      { time: 10, value: 1, color: "#10b437" },
      { time: 15, value: -1, color: "#e34b4b" },
      { time: 20, value: 0, color: "rgba(69, 211, 195, 0.18)" },
    ],
  );

  assert.deepEqual(
    driverEventsToMarkers([
      { id: "a", openedAt: 10_000, side: "LONG", status: "OPEN" },
      {
        id: "b",
        openedAt: 15_000,
        side: "SHORT",
        status: "TP",
        phase: "FINAL_EXIT",
        tp1HitAt: 17_000,
        fadeNotifiedAt: 18_000,
        closedAt: 20_000,
        exitReason: "FADE_TIMEOUT",
      },
    ]),
    [
      {
        time: 10,
        position: "belowBar",
        color: "#10b437",
        shape: "arrowUp",
        text: "ENTRY L",
      },
      {
        time: 15,
        position: "aboveBar",
        color: "#e34b4b",
        shape: "arrowDown",
        text: "ENTRY S",
      },
      {
        time: 17,
        position: "belowBar",
        color: "#45d3c3",
        shape: "circle",
        text: "TP1",
      },
      {
        time: 18,
        position: "aboveBar",
        color: "#f5b84b",
        shape: "circle",
        text: "FADE",
      },
      {
        time: 20,
        position: "belowBar",
        color: "#45d3c3",
        shape: "circle",
        text: "EXIT",
      },
    ],
  );

  assert.deepEqual(
    driverEventsToCompactMarkers([
      { id: "a", openedAt: 10_000, side: "LONG", status: "OPEN" },
      { id: "b", openedAt: 15_000, side: "SHORT", status: "SL", phase: "FINAL_EXIT", tp1HitAt: 17_000, closedAt: 20_000 },
    ]),
    [
      {
        time: 10,
        position: "belowBar",
        color: "#10b437",
        shape: "arrowUp",
      },
      {
        time: 15,
        position: "aboveBar",
        color: "#e34b4b",
        shape: "arrowDown",
      },
      {
        time: 17,
        position: "belowBar",
        color: "#45d3c3",
        shape: "circle",
      },
      {
        time: 20,
        position: "aboveBar",
        color: "#e34b4b",
        shape: "circle",
      },
    ],
  );

  assert.deepEqual(
    driverEventsToMarkers([
      { id: "p1", openedAt: 25_000, side: "LONG", status: "PENDING" },
      { id: "p2", openedAt: 30_000, side: "SHORT", status: "CANCELLED", closedAt: 35_000 },
      { id: "p3", openedAt: 40_000, side: "LONG", status: "CONVERTED", closedAt: 45_000 },
    ]),
    [
      {
        time: 25,
        position: "belowBar",
        color: "#f5b84b",
        shape: "square",
        text: "PEND L",
      },
      {
        time: 30,
        position: "aboveBar",
        color: "#f5b84b",
        shape: "square",
        text: "PEND S",
      },
      {
        time: 35,
        position: "aboveBar",
        color: "#7c8a86",
        shape: "circle",
        text: "CANCEL",
      },
      {
        time: 40,
        position: "belowBar",
        color: "#f5b84b",
        shape: "square",
        text: "PEND L",
      },
      {
        time: 45,
        position: "belowBar",
        color: "#45d3c3",
        shape: "circle",
        text: "CONV",
      },
    ],
  );
});

test("historyToLineData renders optional Hyperliquid perp fields by bucket close", () => {
  const history = [
    { time: 10, funding: 0.00001 },
    { time: 11, funding: -0.00002 },
    { time: 15, funding: 0.00003 },
  ];

  assert.deepEqual(historyToLineData(history, "funding", 5, "#45d3c3"), [
    { time: 10, value: -0.00002, color: NEGATIVE_TWAP_COLOR },
    { time: 15, value: 0.00003, color: "#45d3c3" },
  ]);
});

test("requiredHistoryHoursForDriverEvents covers all stored signal markers", () => {
  assert.equal(
    requiredHistoryHoursForDriverEvents(
      [
        { openedAt: 1_000, side: "LONG", status: "OPEN" },
        { openedAt: 60 * 60_000, closedAt: 90 * 60_000, side: "LONG", status: "TP" },
      ],
      3 * 60 * 60,
    ),
    3,
  );
  assert.equal(requiredHistoryHoursForDriverEvents([], 3 * 60 * 60), null);
});

test("visibleTimeRangeForDriverEvents focuses around all stored signal markers", () => {
  assert.deepEqual(
    visibleTimeRangeForDriverEvents(
      [
        { openedAt: 60_000, side: "LONG", status: "OPEN" },
        { openedAt: 5 * 60_000, closedAt: 10 * 60_000, side: "LONG", status: "TP" },
      ],
      120,
    ),
    { from: -60, to: 720 },
  );
  assert.equal(visibleTimeRangeForDriverEvents([], 120), null);
});

test("historyToAlignedLineData preserves sparse indicator time buckets with whitespace points", () => {
  const history = [
    { time: 10, price: 100 },
    { time: 11, price: 101, funding: 0.00001 },
    { time: 12, price: 102 },
    { time: 15, price: 103, funding: -0.00002 },
  ];

  assert.deepEqual(historyToAlignedLineData(history, "funding", 5, "#45d3c3"), [
    { time: 10, value: 0.00001, color: "#45d3c3" },
    { time: 15, value: -0.00002, color: NEGATIVE_TWAP_COLOR },
  ]);

  assert.deepEqual(historyToAlignedLineData(history, "openInterest", 5, "#7aa8ff"), [
    { time: 10 },
    { time: 15 },
  ]);
});

test("historyToPriceBars aggregates live prices into selected resolution OHLC bars", () => {
  const history = [
    { time: 10, price: 100 },
    { time: 11, price: 102 },
    { time: 12, price: 99 },
    { time: 15, price: 101 },
    { time: 16, price: 98 },
  ];

  assert.deepEqual(historyToPriceBars(history, 5), [
    { time: 10, open: 100, high: 102, low: 99, close: 99 },
    { time: 15, open: 99, high: 101, low: 98, close: 98 },
  ]);
});

test("aligned chart series keep identical bucket times for synchronized time scales", () => {
  const history = [
    { time: 10, price: 100, next1h: 10 },
    { time: 11, next1h: 11, funding: 0.00001 },
    { time: 15, price: 101, funding: 0.00002 },
  ];

  const times = (points) => points.map((point) => point.time);

  assert.deepEqual(times(historyToAlignedPriceBars(history, 5)), [10, 15]);
  assert.deepEqual(times(historyToAlignedLineData(history, "next1h", 5, "#10b437")), [10, 15]);
  assert.deepEqual(times(historyToAlignedLineData(history, "funding", 5, "#45d3c3")), [10, 15]);
});

test("historyToLineData samples TWAP by bucket close and colors negative values red", () => {
  const history = [
    { time: 10, next1h: 100 },
    { time: 11, next1h: -25 },
    { time: 15, next1h: 50 },
  ];

  assert.deepEqual(historyToLineData(history, "next1h", 5, "#10b437"), [
    { time: 10, value: -25, color: NEGATIVE_TWAP_COLOR },
    { time: 15, value: 50, color: "#10b437" },
  ]);
});

test("needsVerticalAutoscale detects values outside the current visible price range", () => {
  const line = [
    { time: 10, value: 100 },
    { time: 11, value: 110 },
    { time: 12, value: 90 },
  ];
  const bars = [
    { time: 10, open: 55, high: 56, low: 54, close: 55.5 },
    { time: 11, open: 55.5, high: 57, low: 55, close: 56.5 },
  ];

  assert.deepEqual(visibleDataRange(line), { min: 90, max: 110 });
  assert.equal(needsVerticalAutoscale(line, { from: 80, to: 120 }), false);
  assert.equal(needsVerticalAutoscale(line, { from: 95, to: 120 }), true);
  assert.equal(needsVerticalAutoscale(bars, { from: 54, to: 57 }), false);
  assert.equal(needsVerticalAutoscale(bars, { from: 54.5, to: 57 }), true);
  assert.equal(needsVerticalAutoscale(line, { from: 95, to: 120 }, { from: 11, to: 12 }), true);
  assert.equal(needsVerticalAutoscale(line, { from: 80, to: 120 }, { from: 10, to: 11 }), false);
});

test("shouldFollowLiveRange tracks whether the chart is already at the live edge", () => {
  assert.equal(shouldFollowLiveRange(null, 160), true);
  assert.equal(shouldFollowLiveRange({ from: 100, to: 160 }, 160), true);
  assert.equal(shouldFollowLiveRange({ from: 100, to: 159 }, 160), true);
  assert.equal(shouldFollowLiveRange({ from: 100, to: 155 }, 160), false);
});

test("shouldKeepLiveFollowing stops auto-scroll after the user leaves live mode", () => {
  assert.equal(shouldKeepLiveFollowing(true, { from: 100, to: 160 }, 160), true);
  assert.equal(shouldKeepLiveFollowing(false, { from: 100, to: 160 }, 160), false);
});

test("nextLiveVisibleRange advances the live window without changing current zoom", () => {
  assert.deepEqual(nextLiveVisibleRange({ from: 100, to: 160 }, 1, 161), { from: 101, to: 161 });
  assert.deepEqual(nextLiveVisibleRange(null, 1, 7_200), { from: 3_600, to: 7_200 });
  assert.equal(nextLiveVisibleRange({ from: 100, to: 100 }, 1, 161), null);
});

test("minimumBarSpacingForRange allows 12h of 15s bars on mobile", () => {
  assert.equal(minimumBarSpacingForRange(390, 12, 15) <= 0.13, true);
  assert.equal(minimumBarSpacingForRange(390, 24, 15) <= 0.07, true);
  assert.equal(minimumBarSpacingForRange(1200, 1, 1) <= 0.31, true);
});

test("selectedHistoryWindow limits rendered points to the selected chart range", () => {
  const history = [
    { time: 1, price: 1 },
    { time: 3_600, price: 2 },
    { time: 7_200, price: 3 },
    { time: 10_800, price: 4 },
  ];

  assert.deepEqual(selectedHistoryWindow(history, 1), [
    { time: 7_200, price: 3 },
    { time: 10_800, price: 4 },
  ]);
  assert.deepEqual(selectedHistoryWindow(history, 2, 7_200), [
    { time: 1, price: 1 },
    { time: 3_600, price: 2 },
    { time: 7_200, price: 3 },
  ]);
});

test("incremental line and price updates match full bucket aggregation", () => {
  const history = [
    { time: 10, price: 100, next1h: 100 },
    { time: 11, price: 102, next1h: -25 },
    { time: 15, price: 99, next1h: 50 },
  ];

  const line = history.reduce(
    (data, point) => upsertLineDataPoint(data, point, "next1h", 5, "#10b437"),
    [],
  );
  const bars = history.reduce((data, point) => upsertPriceBarData(data, point, 5), []);

  assert.deepEqual(line, historyToLineData(history, "next1h", 5, "#10b437"));
  assert.deepEqual(bars, historyToPriceBars(history, 5));
});

test("incremental aligned line updates keep empty buckets on the shared time axis", () => {
  const points = [
    { time: 10, price: 100 },
    { time: 11, price: 101, funding: 0.00001 },
    { time: 15, price: 102 },
  ];

  const line = points.reduce(
    (data, point) => upsertAlignedLineDataPoint(data, point, "funding", 5, "#45d3c3"),
    [],
  );

  assert.deepEqual(line, [
    { time: 10, value: 0.00001, color: "#45d3c3" },
    { time: 15 },
  ]);
});

test("incremental aligned price updates keep empty buckets on the shared time axis", () => {
  const points = [
    { time: 10, price: 100 },
    { time: 11, next1h: 101 },
    { time: 15, price: 102 },
  ];

  const bars = points.reduce((data, point) => upsertAlignedPriceBarData(data, point, 5), []);

  assert.deepEqual(bars, [
    { time: 10, open: 100, high: 100, low: 100, close: 100 },
    { time: 15, open: 100, high: 102, low: 100, close: 102 },
  ]);
});

test("pruneSeriesData drops points older than the visible data window", () => {
  assert.deepEqual(
    pruneSeriesData(
      [
        { time: 10, value: 1 },
        { time: 15, value: 2 },
      ],
      12,
    ),
    [{ time: 15, value: 2 }],
  );
});
