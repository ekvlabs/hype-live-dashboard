export const DEFAULT_HISTORY_MAX_POINTS = 30_000;
const HISTORY_RESOLUTION_STEPS_SECONDS = [1, 5, 15, 60, 300, 900, 1800, 3600];

export function compactState(state) {
  return {
    snapshot: state.snapshot ?? null,
    status: state.status,
    config: state.config,
  };
}

export function historyPayload(state, options = {}) {
  const config = state?.config ?? {};
  const history = Array.isArray(state?.history) ? state.history : [];
  const latestTimestamp = latestHistoryTimestamp(history);

  if (!Number.isFinite(latestTimestamp)) {
    return emptyHistoryPayload(config, options);
  }

  const query = historyPayloadQuery(config, options, latestTimestamp);
  const windowHistory = history.filter((point) => Number(point?.t) >= query.from && Number(point?.t) <= latestTimestamp);
  const compactedHistory = compactHistoryByResolution(windowHistory, query.historyResolutionSeconds);

  return historyPayloadResponse(compactedHistory, config, query);
}

export function emptyHistoryPayload(config = {}, options = {}) {
  const query = historyPayloadQuery(config, options);

  return historyPayloadResponse([], config, query);
}

export function historyPayloadQuery(config = {}, options = {}, latestTimestamp = NaN) {
  const maxHistoryHours = Math.max(1, Number(config.maxHistoryHours) || 336);
  const historyHours = clampNumber(options.hours, 1, maxHistoryHours, Math.min(24, maxHistoryHours));
  const requestedResolutionSeconds = Math.max(1, Number(options.resolutionSeconds) || 1);
  const maxPoints = Math.max(1, Number(options.maxPoints) || DEFAULT_HISTORY_MAX_POINTS);
  const historyResolutionSeconds = Number.isFinite(latestTimestamp)
    ? effectiveHistoryResolutionSeconds(historyHours, requestedResolutionSeconds, maxPoints)
    : requestedResolutionSeconds;

  return {
    historyHours,
    historyResolutionSeconds,
    latestTimestamp,
    from: Number.isFinite(latestTimestamp) ? latestTimestamp - historyHours * 60 * 60_000 : NaN,
  };
}

export function historyPayloadResponse(history, config = {}, query = {}) {
  return {
    history,
    config: {
      ...config,
      historyResolutionSeconds: query.historyResolutionSeconds,
      historyHours: query.historyHours,
      historyPoints: history.length,
    },
  };
}

export function historyPointEvent(point) {
  return { point };
}

export function sseFrame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function effectiveHistoryResolutionSeconds(hours, requestedResolutionSeconds, maxPoints) {
  const spanSeconds = Math.max(1, Number(hours) || 1) * 60 * 60;
  const requested = Math.max(1, Number(requestedResolutionSeconds) || 1);
  const minimum = Math.ceil(spanSeconds / Math.max(1, Number(maxPoints) || DEFAULT_HISTORY_MAX_POINTS));
  return roundHistoryResolutionSeconds(Math.max(requested, minimum));
}

function roundHistoryResolutionSeconds(seconds) {
  const minimum = Math.max(1, Number(seconds) || 1);
  return HISTORY_RESOLUTION_STEPS_SECONDS.find((step) => step >= minimum) ?? minimum;
}

export function compactHistoryByResolution(history, resolutionSeconds) {
  const bucketMs = Math.max(1, Number(resolutionSeconds) || 1) * 1000;
  const buckets = new Map();

  for (const point of history ?? []) {
    const timestamp = Number(point?.t);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    buckets.set(Math.floor(timestamp / bucketMs) * bucketMs, point);
  }

  return [...buckets.values()].sort((a, b) => Number(a.t) - Number(b.t));
}

function latestHistoryTimestamp(history) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const timestamp = Number(history[index]?.t);
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return NaN;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}
