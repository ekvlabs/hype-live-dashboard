export function compactState(state) {
  return {
    snapshot: state.snapshot ?? null,
    status: state.status,
    config: state.config,
  };
}

export function historyPointEvent(point) {
  return { point };
}

export function sseFrame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
