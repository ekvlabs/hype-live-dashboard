const DRIVER_Q24_THRESHOLD_HYPE = 80_000;
const DRIVER_LOOKBACK_MS = 60 * 60_000;
const DRIVER_PRICE_SHORT_LOOKBACK_MS = 5 * 60_000;
const DRIVER_MIN_MONO = 0.65;
const DRIVER_MAX_PRICE_5M_BP = 10;
const DRIVER_MAX_PRICE_60M_BP = 80;
const DRIVER_PENDING_GRACE_MS = 10 * 60_000;
const DRIVER_PENDING_MAX_PRICE_5M_BP = 30;
const DRIVER_PENDING_MAX_PRICE_60M_BP = 120;
const DRIVER_MAX_PREMIUM_BP = 8;
const DRIVER_COLLECT_COOLDOWN_MS = 30 * 60_000;
const DRIVER_MAX_HOLD_MS = 360 * 60_000;
const LIVE_RESEARCH_DEDUP_MS = 5 * 60_000;
const RESEARCH_CACHE_TTL_MS = 60_000;

const SIGNAL_STATUSES = new Set(["OPEN", "TP", "SL", "TIME", "OPPOSITE", "PENDING", "CONVERTED", "CANCELLED"]);

let researchCache = {
  signature: "",
  generatedAt: 0,
  items: [],
};

export function twapDriverSignalEventsPayload({ livePayload = {}, history = [], options = {} } = {}) {
  const liveItems = normalizeLiveEvents(livePayload.items ?? []);
  const earliestLiveOpenedAt = earliestOpenedAt(liveItems);
  const researchItems = cachedResearchTwapDriverEvents(history)
    .filter((event) => !Number.isFinite(earliestLiveOpenedAt) || event.openedAt < earliestLiveOpenedAt - LIVE_RESEARCH_DEDUP_MS);
  const safeSince = Math.max(0, Number(options.since) || 0);
  const safeStatus = normalizeStatus(options.status);
  const safeLimit = Math.min(2_000, Math.max(1, Number(options.limit) || 100));

  const items = [...liveItems, ...researchItems]
    .filter((event) => Number(event.openedAt) >= safeSince)
    .filter((event) => !safeStatus || String(event.status ?? "").toUpperCase() === safeStatus)
    .sort((a, b) => Number(b.openedAt) - Number(a.openedAt))
    .slice(0, safeLimit);

  return {
    items,
    stats: {
      ...(livePayload.stats ?? {}),
      researchTotal: researchItems.length,
      liveTotal: liveItems.length,
    },
  };
}

export function generateResearchTwapDriverEvents(history = []) {
  const samples = normalizeSamples(history);
  if (samples.length < 2) {
    return [];
  }

  const grossPrefix = q24GrossPrefix(samples);
  const events = [
    ...collectResearchEvents(samples, grossPrefix, "TWAP_DRIVER"),
    ...collectResearchEvents(samples, grossPrefix, "PENDING_DRIVER"),
  ];

  return events.sort((a, b) => Number(b.openedAt) - Number(a.openedAt));
}

function cachedResearchTwapDriverEvents(history) {
  const signature = historySignature(history);
  const now = Date.now();
  if (researchCache.signature === signature && now - researchCache.generatedAt < RESEARCH_CACHE_TTL_MS) {
    return researchCache.items;
  }

  const items = generateResearchTwapDriverEvents(history);
  researchCache = {
    signature,
    generatedAt: now,
    items,
  };
  return items;
}

function normalizeLiveEvents(items) {
  return (items ?? [])
    .map((event) => {
      const openedAt = Number(event?.openedAt);
      if (!Number.isFinite(openedAt)) {
        return null;
      }
      const status = String(event?.status ?? "").toUpperCase();
      return {
        ...event,
        source: event?.source ?? "live",
        kind: event?.kind ?? (status === "PENDING" ? "PENDING_DRIVER" : "TWAP_DRIVER"),
        openedAt,
      };
    })
    .filter(Boolean);
}

function normalizeSamples(history) {
  return (history ?? [])
    .map(sampleFromHistoryPoint)
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
}

function sampleFromHistoryPoint(point) {
  const t = Number(point?.t);
  const price = Number(point?.price);
  const next1h = Number(point?.next1h);
  const next24h = Number(point?.next24h);
  if (!Number.isFinite(t) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(next1h) || !Number.isFinite(next24h)) {
    return null;
  }
  return {
    t,
    price,
    q1: next1h / price,
    q24: next24h / price,
    premium: Number(point?.premium),
  };
}

function q24GrossPrefix(samples) {
  const prefix = [0];
  for (let index = 1; index < samples.length; index += 1) {
    prefix[index] = prefix[index - 1] + Math.abs(samples[index].q24 - samples[index - 1].q24);
  }
  return prefix;
}

function collectResearchEvents(samples, grossPrefix, kind) {
  let previous60mIndex = 0;
  let previous5mIndex = 0;
  let lastAcceptedAt = -Infinity;
  const events = [];

  for (let index = 0; index < samples.length; index += 1) {
    const current = samples[index];
    previous60mIndex = advanceFirstAtOrAfterIndex(samples, previous60mIndex, index, current.t - DRIVER_LOOKBACK_MS);
    previous5mIndex = advanceFirstAtOrAfterIndex(
      samples,
      previous5mIndex,
      index,
      current.t - DRIVER_PRICE_SHORT_LOOKBACK_MS,
    );

    if (previous60mIndex >= index || previous5mIndex >= index || current.t < lastAcceptedAt + DRIVER_COLLECT_COOLDOWN_MS) {
      continue;
    }

    const candidate = detectResearchCandidate({
      samples,
      grossPrefix,
      index,
      previous60mIndex,
      previous5mIndex,
    });
    if (!candidate || !candidateMatchesKind(candidate, kind)) {
      continue;
    }

    events.push(researchEventFromCandidate(current, candidate, kind));
    lastAcceptedAt = current.t;
  }

  return events;
}

function advanceFirstAtOrAfterIndex(samples, currentLookbackIndex, currentIndex, targetTime) {
  let nextIndex = currentLookbackIndex;
  while (nextIndex < currentIndex && samples[nextIndex].t < targetTime) {
    nextIndex += 1;
  }
  return nextIndex;
}

function detectResearchCandidate({ samples, grossPrefix, index, previous60mIndex, previous5mIndex }) {
  const current = samples[index];
  const previous60m = samples[previous60mIndex];
  const previous5m = samples[previous5mIndex];
  const dq24 = current.q24 - previous60m.q24;
  if (!Number.isFinite(dq24) || Math.abs(dq24) <= DRIVER_Q24_THRESHOLD_HYPE) {
    return null;
  }

  const side = Math.sign(dq24);
  if (side * current.q1 <= 0 || side * current.q24 <= 0) {
    return null;
  }

  const gross = grossPrefix[index] - grossPrefix[previous60mIndex];
  if (index - previous60mIndex < 2) {
    return null;
  }
  const mono24 = gross > 0 ? Math.abs(dq24) / gross : NaN;
  if (!Number.isFinite(mono24) || mono24 < DRIVER_MIN_MONO) {
    return null;
  }

  const priceRet5mBp = priceMoveBp(previous5m.price, current.price, 1);
  const priceRet60mBp = priceMoveBp(previous60m.price, current.price, 1);
  const priceEligible = side * priceRet5mBp < DRIVER_MAX_PRICE_5M_BP && side * priceRet60mBp < DRIVER_MAX_PRICE_60M_BP;
  const pendingEligible =
    side * priceRet5mBp < DRIVER_PENDING_MAX_PRICE_5M_BP &&
    side * priceRet60mBp < DRIVER_PENDING_MAX_PRICE_60M_BP;
  if (!priceEligible && !pendingEligible) {
    return null;
  }

  const premiumBp = Number.isFinite(current.premium) ? current.premium * 10_000 : null;
  if (premiumBp !== null && side * premiumBp >= DRIVER_MAX_PREMIUM_BP) {
    return null;
  }

  return {
    side,
    dq24,
    q1: current.q1,
    q24: current.q24,
    mono24,
    priceRet5mBp,
    priceRet60mBp,
    premiumBp,
    priceEligible,
  };
}

function candidateMatchesKind(candidate, kind) {
  if (kind === "TWAP_DRIVER") {
    return candidate.priceEligible;
  }
  if (kind === "PENDING_DRIVER") {
    return !candidate.priceEligible;
  }
  return false;
}

function researchEventFromCandidate(sample, candidate, kind) {
  const sideLabel = candidate.side > 0 ? "LONG" : "SHORT";
  const pending = kind === "PENDING_DRIVER";
  const idSide = candidate.side > 0 ? "long" : "short";
  const idSuffix = pending ? "pending" : "entry";

  return {
    id: `research:${kind}:${sample.t}:${idSide}`,
    source: "research",
    kind,
    openedAt: sample.t,
    side: sideLabel,
    entryPrice: sample.price,
    expiresAt: sample.t + (pending ? DRIVER_PENDING_GRACE_MS : DRIVER_MAX_HOLD_MS),
    status: pending ? "PENDING" : "OPEN",
    updatedAt: sample.t,
    hitCount: 1,
    lastHitAt: sample.t,
    lastNoticeAt: sample.t,
    mfeBp: 0,
    maeBp: 0,
    phase: pending ? "PENDING" : "ACTIVE",
    tp1HitAt: 0,
    breakevenHitAt: 0,
    runnerStartedAt: 0,
    weakNotifiedAt: 0,
    fadeNotifiedAt: 0,
    exitReason: "",
    meta: {
      idSuffix,
      dq24: round(candidate.dq24),
      q1: round(candidate.q1),
      q24: round(candidate.q24),
      mono24: round(candidate.mono24),
      priceRet5mBp: round(candidate.priceRet5mBp),
      priceRet60mBp: round(candidate.priceRet60mBp),
      premiumBp: candidate.premiumBp === null ? null : round(candidate.premiumBp),
    },
  };
}

function priceMoveBp(entryPrice, currentPrice, side) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(currentPrice)) {
    return NaN;
  }
  return side * (currentPrice / entryPrice - 1) * 10_000;
}

function earliestOpenedAt(items) {
  let earliest = Infinity;
  for (const item of items ?? []) {
    const openedAt = Number(item?.openedAt);
    if (Number.isFinite(openedAt)) {
      earliest = Math.min(earliest, openedAt);
    }
  }
  return Number.isFinite(earliest) ? earliest : NaN;
}

function normalizeStatus(status) {
  const value = String(status ?? "").trim().toUpperCase();
  return SIGNAL_STATUSES.has(value) ? value : "";
}

function historySignature(history) {
  const length = Number(history?.length) || 0;
  const first = firstPoint(history);
  const last = lastPoint(history);
  return [
    length,
    pointSignature(first),
    pointSignature(last),
  ].join("|");
}

function firstPoint(history) {
  for (const point of history ?? []) {
    if (point) {
      return point;
    }
  }
  return null;
}

function lastPoint(history) {
  for (let index = (history?.length ?? 0) - 1; index >= 0; index -= 1) {
    if (history[index]) {
      return history[index];
    }
  }
  return null;
}

function pointSignature(point) {
  if (!point) {
    return "";
  }
  return [
    Number(point.t) || 0,
    Number(point.price) || 0,
    Number(point.next1h) || 0,
    Number(point.next24h) || 0,
    Number(point.premium) || 0,
  ].join(":");
}

function round(value) {
  return Number(Number(value).toFixed(6));
}
