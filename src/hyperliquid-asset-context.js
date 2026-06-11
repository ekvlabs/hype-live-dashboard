const DEFAULT_WS_URL = "wss://api.hyperliquid.xyz/ws";

export class HyperliquidAssetContextStream {
  constructor({
    coin = "HYPE",
    webSocketUrl = DEFAULT_WS_URL,
    WebSocketImpl = globalThis.WebSocket,
    reconnectMs = 5_000,
    now = Date.now,
  } = {}) {
    this.coin = coin;
    this.webSocketUrl = webSocketUrl;
    this.WebSocketImpl = WebSocketImpl;
    this.reconnectMs = reconnectMs;
    this.now = now;
    this.ws = null;
    this.reconnectTimer = null;
    this.running = false;
    this.context = null;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close?.();
      this.ws = null;
    }
  }

  latest() {
    return this.context;
  }

  connect() {
    if (!this.running || !this.WebSocketImpl) {
      return;
    }

    const ws = new this.WebSocketImpl(this.webSocketUrl);
    this.ws = ws;

    ws.addEventListener?.("open", () => {
      ws.send(
        JSON.stringify({
          method: "subscribe",
          subscription: { type: "activeAssetCtx", coin: this.coin },
        }),
      );
    });

    ws.addEventListener?.("message", (event) => {
      const context = extractActiveAssetContext(parseMessage(event.data), {
        coin: this.coin,
        updatedAt: this.now(),
      });
      if (context) {
        this.context = context;
      }
    });

    ws.addEventListener?.("close", () => {
      if (this.ws === ws) {
        this.ws = null;
      }
      this.scheduleReconnect();
    });

    ws.addEventListener?.("error", () => {
      ws.close?.();
    });
  }

  scheduleReconnect() {
    if (!this.running || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectMs);
    this.reconnectTimer.unref?.();
  }
}

export function extractActiveAssetContext(message, { coin = "HYPE", updatedAt = Date.now() } = {}) {
  if (!message || message.channel !== "activeAssetCtx") {
    return null;
  }

  const data = message.data ?? {};
  const dataCoin = String(data.coin ?? coin).toUpperCase();
  if (dataCoin !== String(coin).toUpperCase()) {
    return null;
  }

  return normalizePerpAssetContext(data.ctx ?? data, {
    coin: dataCoin,
    source: "ws",
    updatedAt,
  });
}

export function normalizePerpAssetContext(context, { coin = "HYPE", source = "rest", updatedAt = Date.now() } = {}) {
  const fields = {
    funding: finiteNumber(context?.funding),
    openInterest: finiteNumber(context?.openInterest),
    premium: finiteNumber(context?.premium),
    markPx: finiteNumber(context?.markPx),
    midPx: finiteNumber(context?.midPx),
    oraclePx: finiteNumber(context?.oraclePx),
    dayNtlVlm: finiteNumber(context?.dayNtlVlm),
  };
  const numericFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => Number.isFinite(value)));

  if (!Object.keys(numericFields).length) {
    return null;
  }

  return {
    coin,
    ...numericFields,
    source,
    updatedAt,
  };
}

function parseMessage(data) {
  if (typeof data !== "string") {
    return data;
  }

  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
