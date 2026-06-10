const SPOT_MARKET_OFFSET = 10_000;
const HYPE_STABLE_PRIORITY = ["USDC", "USDT0", "USDE", "USDH"];

export function buildMarketState(spotMetaOrOptions, spotContexts = [], allMids = {}) {
  const options = normalizeBuildMarketOptions(spotMetaOrOptions, spotContexts, allMids);
  const marketType = options.marketType ?? "spot";
  const includePerps = marketType === "all" || marketType === "perps";
  const includeSpot = marketType === "all" || marketType === "spot";
  const marketsById = new Map();

  if (includePerps) {
    for (let index = 0; index < (options.perpMeta?.universe?.length ?? 0); index += 1) {
      const market = options.perpMeta.universe[index];
      if (!market) {
        continue;
      }
      const context = options.perpContexts[index] ?? {};
      const token = market.name?.toUpperCase() ?? String(index);
      const price = firstFiniteNumber(context.midPx, context.markPx, options.allMids[token]);
      marketsById.set(index, {
        id: index,
        index,
        type: "perp",
        coin: token,
        name: token,
        token,
        quote: "USD",
        price,
        dayVolume: firstFiniteNumber(context.dayNtlVlm),
      });
    }
  }

  if (includeSpot) {
    addSpotMarkets(marketsById, options.spotMeta, options.spotContexts, options.allMids);
  }

  const hypeMarketIds = [...marketsById.values()]
    .filter((market) => market.token === "HYPE")
    .sort(compareHypeMarkets)
    .map((market) => market.id);

  return { marketsById, hypeMarketIds };
}

function addSpotMarkets(marketsById, spotMeta, spotContexts = [], allMids = {}) {
  const tokenByIndex = new Map();
  for (const token of spotMeta?.tokens ?? []) {
    tokenByIndex.set(Number(token.index), token);
  }

  for (const market of spotMeta?.universe ?? []) {
    const marketIndex = Number(market.index);
    const marketId = SPOT_MARKET_OFFSET + marketIndex;
    const [baseIndex, quoteIndex] = market.tokens ?? [];
    const baseToken = tokenByIndex.get(Number(baseIndex));
    const quoteToken = tokenByIndex.get(Number(quoteIndex));
    const context = spotContexts[marketIndex] ?? {};
    const price = firstFiniteNumber(context.midPx, context.markPx, allMids[`@${marketIndex}`]);

    marketsById.set(marketId, {
      id: marketId,
      index: marketIndex,
      type: "spot",
      coin: `@${marketIndex}`,
      name: market.name ?? `@${marketIndex}`,
      token: baseToken?.name?.toUpperCase() ?? String(baseIndex),
      quote: quoteToken?.name?.toUpperCase() ?? String(quoteIndex),
      price,
      dayVolume: firstFiniteNumber(context.dayNtlVlm),
    });
  }
}

export function calculateTwapValue(twap, marketState) {
  const marketId = Number(twap?.action?.twap?.a);
  const size = Number(twap?.action?.twap?.s);
  const price = marketState.marketsById.get(marketId)?.price;

  if (!Number.isFinite(size) || !Number.isFinite(price)) {
    return null;
  }

  return size * price;
}

export function getActiveTwaps(twaps, marketState, now = Date.now()) {
  const active = [];

  for (const twap of twaps ?? []) {
    if (twap?.ended || twap?.error) {
      continue;
    }

    const order = twap?.action?.twap;
    const startedAt = Number(twap?.time);
    const durationMs = Number(order?.m) * 60_000;
    const value = calculateTwapValue(twap, marketState);

    if (
      !order ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      !Number.isFinite(value) ||
      value < 0 ||
      startedAt + durationMs <= now
    ) {
      continue;
    }

    active.push({
      ...twap,
      marketId: Number(order.a),
      token: marketState.marketsById.get(Number(order.a))?.token ?? String(order.a),
      side: order.b ? "BUY" : "SELL",
      value,
      startedAt,
      durationMs,
      endsAt: startedAt + durationMs,
    });
  }

  return active.sort((a, b) => b.value - a.value);
}

export function calculateHypePressure(activeTwaps, hypeMarketIds, now = Date.now()) {
  const hypeMarkets = new Set(hypeMarketIds);

  return {
    next1h: calculatePressureForDuration(activeTwaps, hypeMarkets, now, 60 * 60_000),
    next24h: calculatePressureForDuration(activeTwaps, hypeMarkets, now, 24 * 60 * 60_000),
  };
}

export function calculateTwapPressureTotal(activeTwaps, hypeMarketIds, now = Date.now()) {
  const hypeMarkets = new Set(hypeMarketIds);
  let buy = 0;
  let sell = 0;

  for (const twap of activeTwaps) {
    if (!hypeMarkets.has(twap.marketId)) {
      continue;
    }

    const remainingMs = Math.max(0, twap.endsAt - now);
    const remainingValue = (twap.value / twap.durationMs) * remainingMs;
    if (twap.side === "BUY") {
      buy += remainingValue;
    } else {
      sell += remainingValue;
    }
  }

  return { buy, sell, net: buy - sell };
}

export function getHypePrice(marketState, allMids = {}) {
  for (const marketId of marketState.hypeMarketIds) {
    const market = marketState.marketsById.get(marketId);
    if (market?.quote === "USDC" && Number.isFinite(market.price)) {
      return { price: market.price, source: `spot @${market.index}` };
    }
  }

  for (const marketId of marketState.hypeMarketIds) {
    const market = marketState.marketsById.get(marketId);
    if (Number.isFinite(market?.price)) {
      return { price: market.price, source: `spot @${market.index}` };
    }
  }

  const perpPrice = firstFiniteNumber(allMids.HYPE);
  return Number.isFinite(perpPrice)
    ? { price: perpPrice, source: "perp HYPE" }
    : { price: null, source: "unavailable" };
}

export function summarizeTwaps(activeTwaps, hypeMarketIds) {
  const hypeMarkets = new Set(hypeMarketIds);
  let buyCount = 0;
  let sellCount = 0;
  let buyValue = 0;
  let sellValue = 0;

  for (const twap of activeTwaps) {
    if (!hypeMarkets.has(twap.marketId)) {
      continue;
    }
    if (twap.side === "BUY") {
      buyCount += 1;
      buyValue += twap.value;
    } else {
      sellCount += 1;
      sellValue += twap.value;
    }
  }

  return { buyCount, sellCount, buyValue, sellValue };
}

function calculatePressureForDuration(activeTwaps, hypeMarkets, now, windowMs) {
  let total = 0;

  for (const twap of activeTwaps) {
    if (!hypeMarkets.has(twap.marketId)) {
      continue;
    }

    const overlapMs = Math.max(0, Math.min(twap.endsAt, now + windowMs) - now);
    const windowValue = (twap.value / twap.durationMs) * overlapMs;
    total += twap.side === "BUY" ? windowValue : -windowValue;
  }

  return total;
}

function stablePriority(quote) {
  const index = HYPE_STABLE_PRIORITY.indexOf(quote);
  return index === -1 ? HYPE_STABLE_PRIORITY.length : index;
}

function compareHypeMarkets(a, b) {
  if (a.type !== b.type) {
    return a.type === "perp" ? -1 : 1;
  }
  return stablePriority(a.quote) - stablePriority(b.quote) || a.id - b.id;
}

function normalizeBuildMarketOptions(spotMetaOrOptions, spotContexts, allMids) {
  if (
    spotMetaOrOptions &&
    typeof spotMetaOrOptions === "object" &&
    ("spotMeta" in spotMetaOrOptions ||
      "perpMeta" in spotMetaOrOptions ||
      "marketType" in spotMetaOrOptions)
  ) {
    return {
      spotMeta: spotMetaOrOptions.spotMeta,
      spotContexts: spotMetaOrOptions.spotContexts ?? [],
      perpMeta: spotMetaOrOptions.perpMeta,
      perpContexts: spotMetaOrOptions.perpContexts ?? [],
      allMids: spotMetaOrOptions.allMids ?? {},
      marketType: spotMetaOrOptions.marketType ?? "spot",
    };
  }

  return {
    spotMeta: spotMetaOrOptions,
    spotContexts,
    allMids,
    marketType: "spot",
  };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return null;
}
