export const RESOLUTIONS = [
  { id: "1s", label: "1s", seconds: 1 },
  { id: "5s", label: "5s", seconds: 5 },
  { id: "15s", label: "15s", seconds: 15 },
  { id: "1m", label: "1m", seconds: 60 },
  { id: "5m", label: "5m", seconds: 300 },
];

export const NEGATIVE_TWAP_COLOR = "#e34b4b";

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

function toUnixSeconds(timestamp) {
  return Math.floor(Number(timestamp) / 1000);
}
