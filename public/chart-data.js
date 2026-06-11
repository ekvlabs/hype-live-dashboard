export const RESOLUTIONS = [
  { id: "1s", label: "1s", seconds: 1 },
  { id: "5s", label: "5s", seconds: 5 },
  { id: "15s", label: "15s", seconds: 15 },
  { id: "1m", label: "1m", seconds: 60 },
  { id: "5m", label: "5m", seconds: 300 },
];

export const NEGATIVE_TWAP_COLOR = "#e34b4b";
export const DEFAULT_MIN_BAR_SPACING = 0.5;
export const ABSOLUTE_MIN_BAR_SPACING = 0.02;

export function normalizedHistory(history) {
  const byTime = new Map();
  for (const point of history ?? []) {
    const time = toUnixSeconds(point.t);
    if (!Number.isFinite(time)) {
      continue;
    }
    byTime.set(time, {
      time,
      price: Number(point.price),
      next1h: Number(point.next1h),
      next24h: Number(point.next24h),
    });
    const normalizedPoint = byTime.get(time);
    for (const key of ["funding", "openInterest", "premium", "markPx", "oraclePx"]) {
      const value = Number(point?.[key]);
      if (Number.isFinite(value)) {
        normalizedPoint[key] = value;
      }
    }
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export function historyToLineData(history, key, resolutionSeconds, positiveColor) {
  const buckets = bucketHistory(history, resolutionSeconds);
  return buckets
    .map((bucket) => {
      const value = Number(bucket.last?.[key]);
      return {
        time: bucket.time,
        value,
        color: value < 0 ? NEGATIVE_TWAP_COLOR : positiveColor,
      };
    })
    .filter((point) => Number.isFinite(point.value));
}

export function historyToAlignedLineData(history, key, resolutionSeconds, positiveColor) {
  const buckets = bucketHistory(history, resolutionSeconds);
  return buckets.map((bucket) => alignedLinePoint(bucket, key, positiveColor));
}

export function historyToPriceBars(history, resolutionSeconds) {
  const buckets = bucketHistory(history, resolutionSeconds);
  const bars = [];
  let previousClose = null;

  for (const bucket of buckets) {
    const prices = bucket.points.map((point) => Number(point.price)).filter(Number.isFinite);
    if (!prices.length) {
      continue;
    }

    const open = previousClose ?? prices[0];
    const close = prices.at(-1);
    bars.push({
      time: bucket.time,
      open,
      high: Math.max(open, ...prices),
      low: Math.min(open, ...prices),
      close,
    });
    previousClose = close;
  }

  return bars;
}

export function visibleDataRange(data, timeRange = null) {
  let min = Infinity;
  let max = -Infinity;

  for (const point of data ?? []) {
    if (timeRange && (Number(point.time) < Number(timeRange.from) || Number(point.time) > Number(timeRange.to))) {
      continue;
    }

    const values = "value" in point ? [point.value] : [point.low, point.high];
    for (const value of values) {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        continue;
      }
      min = Math.min(min, number);
      max = Math.max(max, number);
    }
  }

  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

export function needsVerticalAutoscale(data, priceRange, timeRange = null) {
  const dataRange = visibleDataRange(data, timeRange);
  if (!dataRange || !priceRange) {
    return true;
  }

  const from = Number(priceRange.from);
  const to = Number(priceRange.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return true;
  }

  return dataRange.min < from || dataRange.max > to;
}

export function shouldFollowLiveRange(visibleRange, previousLastTime, toleranceSeconds = 2) {
  if (!visibleRange) {
    return true;
  }

  const liveEdge = Number(previousLastTime);
  const visibleTo = Number(visibleRange.to);
  if (!Number.isFinite(liveEdge) || !Number.isFinite(visibleTo)) {
    return true;
  }

  return visibleTo >= liveEdge - Math.max(0, Number(toleranceSeconds) || 0);
}

export function shouldKeepLiveFollowing(isLiveFollowing, visibleRange, previousLastTime) {
  return Boolean(isLiveFollowing) && shouldFollowLiveRange(visibleRange, previousLastTime);
}

export function nextLiveVisibleRange(visibleRange, selectedHours, nextLastTime) {
  const to = Number(nextLastTime);
  if (!Number.isFinite(to)) {
    return null;
  }

  const selectedSpan = Math.max(1, Number(selectedHours) || 1) * 60 * 60;
  const hasCurrentRange =
    visibleRange && Number.isFinite(Number(visibleRange.from)) && Number.isFinite(Number(visibleRange.to));
  const currentSpan = hasCurrentRange ? Number(visibleRange.to) - Number(visibleRange.from) : selectedSpan;
  if (currentSpan <= 0) {
    return null;
  }

  return { from: to - currentSpan, to };
}

export function selectedHistoryWindow(history, selectedHours, anchorTime = null) {
  if (!history?.length) {
    return [];
  }

  const anchor = Number(anchorTime ?? history.at(-1)?.time);
  if (!Number.isFinite(anchor)) {
    return [];
  }

  const span = Math.max(1, Number(selectedHours) || 1) * 60 * 60;
  const from = anchor - span;
  return history.filter((point) => Number(point.time) >= from && Number(point.time) <= anchor);
}

export function upsertLineDataPoint(data, historyPoint, key, resolutionSeconds, positiveColor) {
  const time = bucketTimeForPoint(historyPoint, resolutionSeconds);
  const value = Number(historyPoint?.[key]);
  if (!Number.isFinite(time) || !Number.isFinite(value)) {
    return data ?? [];
  }

  return upsertSeriesPoint(data, {
    time,
    value,
    color: value < 0 ? NEGATIVE_TWAP_COLOR : positiveColor,
  });
}

export function upsertAlignedLineDataPoint(data, historyPoint, key, resolutionSeconds, positiveColor) {
  const time = bucketTimeForPoint(historyPoint, resolutionSeconds);
  if (!Number.isFinite(time)) {
    return data ?? [];
  }

  const current = data ?? [];
  const existing = current.find((point) => Number(point.time) === time);
  const value = Number(historyPoint?.[key]);
  if (!Number.isFinite(value) && existing && "value" in existing) {
    return current;
  }

  return upsertSeriesPoint(
    current,
    Number.isFinite(value)
      ? {
          time,
          value,
          color: value < 0 ? NEGATIVE_TWAP_COLOR : positiveColor,
        }
      : { time },
  );
}

export function upsertPriceBarData(data, historyPoint, resolutionSeconds) {
  const time = bucketTimeForPoint(historyPoint, resolutionSeconds);
  const price = Number(historyPoint?.price);
  if (!Number.isFinite(time) || !Number.isFinite(price)) {
    return data ?? [];
  }

  const current = data ?? [];
  const next = current.slice();
  const existingIndex = next.findIndex((point) => Number(point.time) === time);
  if (existingIndex >= 0) {
    const bar = next[existingIndex];
    next[existingIndex] = {
      ...bar,
      high: Math.max(Number(bar.high), price),
      low: Math.min(Number(bar.low), price),
      close: price,
    };
    return next;
  }

  const previous = [...next].reverse().find((point) => Number(point.time) < time);
  const open = Number(previous?.close);
  return upsertSeriesPoint(next, {
    time,
    open: Number.isFinite(open) ? open : price,
    high: Number.isFinite(open) ? Math.max(open, price) : price,
    low: Number.isFinite(open) ? Math.min(open, price) : price,
    close: price,
  });
}

export function pruneSeriesData(data, oldestTime) {
  const cutoff = Number(oldestTime);
  if (!Number.isFinite(cutoff)) {
    return data ?? [];
  }
  return (data ?? []).filter((point) => Number(point.time) >= cutoff);
}

export function minimumBarSpacingForRange(containerWidth, selectedHours, resolutionSeconds) {
  const width = Math.max(1, Number(containerWidth) || 1);
  const hours = Math.max(1, Number(selectedHours) || 1);
  const seconds = Math.max(1, Number(resolutionSeconds) || 1);
  const bars = Math.max(1, (hours * 60 * 60) / seconds);
  const requiredSpacing = (width * 0.92) / bars;

  return Math.max(
    ABSOLUTE_MIN_BAR_SPACING,
    Math.min(DEFAULT_MIN_BAR_SPACING, Number(requiredSpacing.toFixed(4))),
  );
}

function bucketHistory(history, resolutionSeconds) {
  const buckets = new Map();
  const seconds = Math.max(1, Number(resolutionSeconds) || 1);

  for (const point of history ?? []) {
    const time = Number(point.time);
    if (!Number.isFinite(time)) {
      continue;
    }

    const bucketTime = Math.floor(time / seconds) * seconds;
    const bucket = buckets.get(bucketTime) ?? { time: bucketTime, points: [], last: null };
    bucket.points.push(point);
    bucket.last = point;
    buckets.set(bucketTime, bucket);
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

function bucketTimeForPoint(point, resolutionSeconds) {
  const time = Number(point?.time);
  const seconds = Math.max(1, Number(resolutionSeconds) || 1);
  return Number.isFinite(time) ? Math.floor(time / seconds) * seconds : NaN;
}

function alignedLinePoint(bucket, key, positiveColor) {
  for (let index = bucket.points.length - 1; index >= 0; index -= 1) {
    const value = Number(bucket.points[index]?.[key]);
    if (Number.isFinite(value)) {
      return {
        time: bucket.time,
        value,
        color: value < 0 ? NEGATIVE_TWAP_COLOR : positiveColor,
      };
    }
  }

  return { time: bucket.time };
}

function upsertSeriesPoint(data, point) {
  const next = (data ?? []).slice();
  const existingIndex = next.findIndex((item) => Number(item.time) === Number(point.time));
  if (existingIndex >= 0) {
    next[existingIndex] = point;
    return next;
  }

  next.push(point);
  next.sort((a, b) => Number(a.time) - Number(b.time));
  return next;
}

function toUnixSeconds(timestamp) {
  return Math.floor(Number(timestamp) / 1000);
}
