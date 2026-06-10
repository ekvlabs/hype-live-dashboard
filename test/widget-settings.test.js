import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWidgetSettings } from "../src/widget-settings.js";

test("normalizeWidgetSettings extracts twapWatch and priceChart settings", () => {
  const settings = normalizeWidgetSettings([
    {
      type: "twapWatch",
      settings: {
        marketType: "all",
        pressureAssets: ["HYPE"],
        pressureMode: "total",
      },
    },
    {
      type: "priceChart",
      settings: {
        coins: ["HYPE"],
        timeframe: "1m",
        chartZoom: { from: 1781057280, to: 1781065620 },
      },
    },
  ]);

  assert.equal(settings.twapWatch.marketType, "all");
  assert.equal(settings.twapWatch.pressureMode, "total");
  assert.deepEqual(settings.priceChart.coins, ["HYPE"]);
  assert.equal(settings.priceChart.timeframe, "1m");
  assert.equal(settings.priceChart.chartZoom.from, 1781057280);
});
