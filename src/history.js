export function historyPointLimit(intervalMs, hours) {
  return Math.ceil((hours * 60 * 60 * 1000) / intervalMs);
}

export function trimHistory(history, now, hours) {
  const cutoff = now - hours * 60 * 60 * 1000;
  return history.filter((point) => Number(point.t) >= cutoff);
}
