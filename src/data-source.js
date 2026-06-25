import { createSnapshot } from "./snapshot.js";
import { historyPointLimit, trimHistory } from "./history.js";
import { fetchJson, fetchJsonWithCurlFallback } from "./http-json.js";
import { HyperliquidAssetContextStream } from "./hyperliquid-asset-context.js";
import { loadWidgetSettings } from "./widget-settings.js";
import { compactState, historyPointEvent } from "./events.js";

const HYPURRSCAN_TWAPS_URL = "https://api.hypurrscan.io/twap/*";
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

export class LiveDataService {
  constructor({
    fetchFn = globalThis.fetch,
    intervalMs = 1_000,
    maxHistoryHours = 336,
    memoryHistoryHours = maxHistoryHours,
    historyCompactMs = 10 * 60 * 1000,
    historyStore = null,
    notifier = null,
    assetContextStream = new HyperliquidAssetContextStream(),
    widgetSettings,
  } = {}) {
    this.fetchFn = fetchFn;
    this.intervalMs = intervalMs;
    this.maxHistoryHours = maxHistoryHours;
    this.memoryHistoryHours = Math.min(
      this.maxHistoryHours,
      Math.max(1, Number(memoryHistoryHours) || this.maxHistoryHours),
    );
    this.historyLimit = historyPointLimit(intervalMs, maxHistoryHours);
    this.memoryHistoryLimit = historyPointLimit(intervalMs, this.memoryHistoryHours);
    this.historyCompactMs = historyCompactMs;
    this.history = [];
    this.listeners = new Set();
    this.snapshot = null;
    this.status = {
      ok: false,
      message: "starting",
      updatedAt: null,
      errorAt: null,
    };
    this.timer = null;
    this.sampleTimer = null;
    this.inFlight = null;
    this.historyStore = historyStore;
    this.assetContextStream = assetContextStream;
    this.nextHistoryCompactAt = Date.now() + historyCompactMs;
    this.notifier = notifier;
    this.widgetSettings = widgetSettings ?? null;
  }

  async start() {
    this.loadStoredHistory();
    this.assetContextStream?.start?.();
    this.startTimers();
    await this.refresh()
      .then(() => {
        this.sampleHistory();
      })
      .catch((error) => {
        console.error("Initial data fetch failed:", error.message);
      });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    this.assetContextStream?.stop?.();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startTimers() {
    if (!this.sampleTimer) {
      this.sampleTimer = setInterval(() => {
        this.sampleHistory();
      }, this.intervalMs);
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.refresh().catch(() => {});
      }, this.intervalMs);
    }
  }

  loadStoredHistory(now = Date.now()) {
    if (!this.historyStore) {
      return;
    }

    try {
      this.history = this.historyStore.load({
        now,
        maxHistoryHours: this.memoryHistoryHours,
        compact: this.memoryHistoryHours >= this.maxHistoryHours,
      });
      this.notifier?.seedHistory?.(this.history);
    } catch (error) {
      console.error("History load failed:", error.message);
    }
  }

  getState() {
    return {
      snapshot: this.snapshot,
      history: this.history,
      status: this.status,
      config: {
        intervalMs: this.intervalMs,
        maxHistoryHours: this.maxHistoryHours,
        historyLimit: this.historyLimit,
        memoryHistoryHours: this.memoryHistoryHours,
        memoryHistoryLimit: this.memoryHistoryLimit,
      },
    };
  }

  async refresh() {
    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.fetchSnapshot()
      .then((snapshot) => {
        this.snapshot = snapshot;
        this.status = {
          ok: true,
          message: "live",
          updatedAt: snapshot.timestamp,
          errorAt: null,
        };
        this.emit("snapshot", compactState(this.getState()));
        this.notifySnapshot(snapshot);
        return snapshot;
      })
      .catch((error) => {
        this.status = {
          ...this.status,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          errorAt: Date.now(),
        };
        this.emit("snapshot", compactState(this.getState()));
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  sampleHistory(now = Date.now()) {
    if (!this.snapshot) {
      return;
    }

    const point = toHistoryPoint(this.snapshot, now);
    this.history.push(point);
    this.history = trimHistory(this.history, now, this.memoryHistoryHours);
    if (this.history.length > this.memoryHistoryLimit) {
      this.history.splice(0, this.history.length - this.memoryHistoryLimit);
    }
    this.persistHistoryPoint(point, now);
    this.emit("history-point", historyPointEvent(point));
  }

  async fetchSnapshot() {
    const widgetSettings = this.widgetSettings ?? (this.widgetSettings = await loadWidgetSettings());

    const [twaps, perpMetaAndContexts, spotMetaAndContexts, allMids] = await Promise.all([
      fetchJsonWithCurlFallback(this.fetchFn, HYPURRSCAN_TWAPS_URL),
      postHyperliquidInfo(this.fetchFn, { type: "metaAndAssetCtxs" }),
      postHyperliquidInfo(this.fetchFn, { type: "spotMetaAndAssetCtxs" }),
      postHyperliquidInfo(this.fetchFn, { type: "allMids" }),
    ]);

    const [perpMeta, perpContexts] = perpMetaAndContexts;
    const [spotMeta, spotContexts] = spotMetaAndContexts;
    return createSnapshot({
      twaps,
      perpMeta,
      perpContexts,
      spotMeta,
      spotContexts,
      candles: [],
      allMids,
      livePerpAssetContext: this.assetContextStream?.latest?.() ?? null,
      widgetSettings,
      now: Date.now(),
    });
  }

  notifySnapshot(snapshot) {
    if (!this.notifier?.enabled) {
      return;
    }

    this.notifier.handleSnapshot(snapshot).catch((error) => {
      console.error("Telegram notification failed:", error.message);
    });
  }

  persistHistoryPoint(point, now) {
    if (!this.historyStore) {
      return;
    }

    try {
      this.historyStore.append(point);
      if (now >= this.nextHistoryCompactAt) {
        if (this.memoryHistoryHours >= this.maxHistoryHours) {
          this.historyStore.replace(this.history);
        }
        this.nextHistoryCompactAt = now + this.historyCompactMs;
      }
    } catch (error) {
      console.error("History persist failed:", error.message);
    }
  }

  emit(type, payload) {
    const event = { type, payload };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

async function postHyperliquidInfo(fetchFn, body) {
  return fetchJson(fetchFn, HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function toHistoryPoint(snapshot, sampledAt = snapshot.timestamp) {
  const point = {
    t: sampledAt,
    price: snapshot.price,
    next1h: snapshot.pressure.next1h,
    next24h: snapshot.pressure.next24h,
  };
  for (const key of ["funding", "openInterest", "premium", "markPx", "oraclePx"]) {
    const value = Number(snapshot.perp?.[key]);
    if (Number.isFinite(value)) {
      point[key] = value;
    }
  }
  return point;
}
