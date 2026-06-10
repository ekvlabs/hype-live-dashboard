import assert from "node:assert/strict";
import test from "node:test";

import {
  NEGATIVE_TWAP_COLOR,
  historyToLineData,
  historyToPriceBars,
  minimumBarSpacingForRange,
  needsVerticalAutoscale,
  nextLiveVisibleRange,
  normalizedHistory,
  pruneSeriesData,
  selectedHistoryWindow,
  shouldFollowLiveRange,
  shouldKeepLiveFollowing,
  upsertLineDataPoint,
  upsertPriceBarData,
  visibleDataRange,
} from "../public/chart-data.js";

test("normalizedHistory keeps one raw point per second with three saved values", () => {
  const history = normalizedHistory([
    { t: 1_000, next1h: "10", next24h: "20", price: "55.1" },
    { t: 1_900, next1h: "11", next24h: "21", price: "55.2" },
    { t: 2_000, next1h: "-5", next24h: "30", price: "55.3" },
  ]);

  assert.deepEqual(history, [
    { time: 1, next1h: 11, next24h: 21, price: 55.2 },
    { time: 2, next1h: -5, next24h: 30, price: 55.3 },
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
