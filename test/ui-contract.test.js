import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("UI shows separate summed TWAP 1h, summed TWAP 24h, and HYPE price charts", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /TWAP HYPE Sum Pressure/);
  assert.match(html, /data-range="24"/);
  assert.match(html, /data-range="72"/);
  assert.match(html, /data-range="168"/);
  assert.match(html, /data-resolution="1s"/);
  assert.match(html, /data-resolution="5s"/);
  assert.match(html, /data-resolution="1m"/);
  assert.match(html, /src="\.\/config\.js/);
  assert.match(html, /href="\.\/styles\.css/);
  assert.match(html, /src="\.\/vendor\/lightweight-charts\.standalone\.production\.js/);
  assert.match(html, /src="\.\/app\.js/);
  assert.match(html, /TWAP 1h/);
  assert.match(html, /TWAP 24h/);
  assert.match(html, /id="twap1hChart"/);
  assert.match(html, /id="twap24hChart"/);
  assert.match(html, /id="priceChart"/);
  assert.match(html, /lightweight-charts\.standalone\.production\.js/);
  assert.match(app, /LightweightCharts/);
  assert.match(app, /LineSeries/);
  assert.match(app, /BarSeries/);
  assert.match(app, /key: "next1h"/);
  assert.match(app, /key: "next24h"/);
  assert.match(app, /const POLL_INTERVAL_MS = 1_000/);
  assert.match(app, /apiPath/);
  assert.match(app, /new EventSource\(apiPath\("\/api\/events"\)\)/);
  assert.match(app, /fetch\(apiPath\("\/api\/snapshot"\)/);
  assert.match(app, /rightPriceScale/);
  assert.match(app, /leftPriceScale:\s*\{\s*visible:\s*false/s);
  assert.match(app, /syncVisibleRange/);
  assert.match(app, /createPriceLine/);
  assert.match(app, /selectedResolution/);
  assert.match(app, /historyToPriceBars/);
  assert.match(app, /historyToLineData/);
  assert.match(app, /autoScaleVertical/);
  assert.match(app, /setAutoScale\(true\)/);
  assert.match(app, /history-point/);
  assert.match(app, /appendHistoryPoint/);
  assert.match(app, /604_800/);
  assert.doesNotMatch(app, /zeroSeries/);
  assert.doesNotMatch(html, /Buy total|Sell total|>BUY<|>SELL<|buyCount|sellCount/);
  assert.doesNotMatch(app, /twapBuy|twapSell|buyCount|sellCount|TWAP buy total|TWAP sell total/);
  assert.doesNotMatch(app, /priceCandles/);
  assert.doesNotMatch(html, /<canvas|chart-scroll|chart-track/);
  assert.doesNotMatch(html, /overlayChart|Live Overlay/);
  assert.doesNotMatch(html, /href="\/styles\.css|src="\/vendor|src="\/app\.js/);
});
