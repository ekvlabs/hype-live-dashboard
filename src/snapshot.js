import {
  buildMarketState,
  calculateHypePressure,
  calculateTwapPressureTotal,
  getActiveTwaps,
  getHypePrice,
  summarizeTwaps,
} from "./pressure.js";

export function createSnapshot({
  twaps,
  spotMeta,
  spotContexts,
  perpMeta,
  perpContexts,
  candles = [],
  allMids,
  widgetSettings = {},
  now = Date.now(),
}) {
  const twapSettings = widgetSettings.twapWatch ?? {};
  const marketType = twapSettings.marketType ?? "spot";
  const marketState = buildMarketState({
    spotMeta,
    spotContexts,
    perpMeta,
    perpContexts,
    allMids,
    marketType,
  });
  const activeTwaps = getActiveTwaps(twaps, marketState, now);
  const priceCandles = normalizePriceCandles(candles);
  const pressure = {
    ...calculateHypePressure(activeTwaps, marketState.hypeMarketIds, now),
    total: calculateTwapPressureTotal(activeTwaps, marketState.hypeMarketIds, now),
  };
  const price = getSnapshotPrice(priceCandles, marketState, allMids);
  const summary = summarizeTwaps(activeTwaps, marketState.hypeMarketIds);

  return {
    timestamp: now,
    price: price.price,
    priceSource: price.source,
    pressure,
    summary,
    activeTwaps: activeTwaps.length,
    activeHypeTwaps: summary.buyCount + summary.sellCount,
    widgetSettings,
    latestCandle: latestCandleInfo(priceCandles),
    priceCandles,
    hypeMarkets: marketState.hypeMarketIds.map((id) => {
      const market = marketState.marketsById.get(id);
      return {
        id,
        coin: market.coin,
        token: market.token,
        quote: market.quote,
        price: market.price,
      };
    }),
  };
}

function normalizePriceCandles(candles) {
  return [...(candles ?? [])]
    .map((candle) => ({
      t: Number(candle?.t),
      open: Number(candle?.o),
      high: Number(candle?.h),
      low: Number(candle?.l),
      close: Number(candle?.c),
      volume: Number(candle?.v),
    }))
    .filter(
      (candle) =>
        Number.isFinite(candle.t) &&
        Number.isFinite(candle.open) &&
        Number.isFinite(candle.high) &&
        Number.isFinite(candle.low) &&
        Number.isFinite(candle.close) &&
        Number.isFinite(candle.volume),
    )
    .sort((a, b) => a.t - b.t);
}

function latestCandleInfo(candles) {
  const latest = candles.at(-1);

  if (!latest) {
    return null;
  }

  return {
    t: latest.t,
    close: latest.close,
    volume: latest.volume,
  };
}

function getSnapshotPrice(candles, marketState, allMids) {
  const livePrice = getHypePrice(marketState, allMids);
  if (Number.isFinite(livePrice.price)) {
    return livePrice;
  }

  const latestCandle = candles.at(-1);

  if (latestCandle) {
    return {
      price: latestCandle.close,
      source: "1m candle HYPE",
    };
  }

  return getHypePrice(marketState, allMids);
}
