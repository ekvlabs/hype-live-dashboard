import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BotStore } from "./bot-store.js";

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1_000;
const DEFAULT_DB_PATH = join(fileURLToPath(new URL("..", import.meta.url)), "data", "bot.sqlite");
const DEFAULT_DASHBOARD_URL = "https://ekvlabs.github.io/hype-live-dashboard/";
const DRIVER_Q24_THRESHOLD_HYPE = 80_000;
const DRIVER_LOOKBACK_MS = 60 * 60 * 1_000;
const DRIVER_PRICE_SHORT_LOOKBACK_MS = 5 * 60 * 1_000;
const DRIVER_MIN_MONO = 0.65;
const DRIVER_MAX_PRICE_5M_BP = 10;
const DRIVER_MAX_PRICE_60M_BP = 80;
const DRIVER_MAX_PREMIUM_BP = 8;
const DRIVER_HISTORY_RETENTION_MS = DRIVER_LOOKBACK_MS + 60_000;
const DRIVER_STOP_BP = 20;
const DRIVER_TAKE_PROFIT_BP = 126;
const DRIVER_MAX_HOLD_MINUTES = 45;

export class TelegramAlertBot {
  constructor({
    botToken,
    store,
    fetchFn = globalThis.fetch,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    pollTimeoutSeconds = 25,
    dashboardUrl = DEFAULT_DASHBOARD_URL,
  } = {}) {
    this.botToken = botToken || "";
    this.store = store;
    this.fetchFn = fetchFn;
    this.cooldownMs = Number(cooldownMs) || DEFAULT_COOLDOWN_MS;
    this.pollTimeoutSeconds = pollTimeoutSeconds;
    this.dashboardUrl = dashboardUrl || DEFAULT_DASHBOARD_URL;
    this.offset = 0;
    this.samples = [];
    this.openSignals = this.store?.listOpenSignals?.() ?? [];
    this.pollTimer = null;
    this.polling = false;
    this.pollAbortController = null;
  }

  static fromEnv(env = process.env) {
    if (!env.TELEGRAM_BOT_TOKEN) {
      return new TelegramAlertBot({});
    }

    return new TelegramAlertBot({
      botToken: env.TELEGRAM_BOT_TOKEN,
      store: new BotStore(env.TELEGRAM_BOT_DB || DEFAULT_DB_PATH),
      cooldownMs: env.TELEGRAM_ALERT_COOLDOWN_MS,
      dashboardUrl: env.TELEGRAM_DASHBOARD_URL || DEFAULT_DASHBOARD_URL,
    });
  }

  get enabled() {
    return Boolean(this.botToken && this.store);
  }

  stats() {
    if (!this.store) {
      return {
        totalUsers: 0,
        enabledUsers: 0,
        disabledUsers: 0,
      };
    }
    return this.store.stats();
  }

  getSignalStats() {
    return this.store?.signalStats?.() ?? createSignalStats();
  }

  seedHistory(history = []) {
    const latestTimestamp = latestHistoryTimestamp(history);
    if (!Number.isFinite(latestTimestamp)) {
      this.samples = [];
      return;
    }
    const cutoff = latestTimestamp - DRIVER_HISTORY_RETENTION_MS;
    this.samples = history
      .filter((point) => Number(point?.t) >= cutoff)
      .map(sampleFromHistoryPoint)
      .filter(Boolean);
  }

  start() {
    if (!this.enabled || this.pollTimer) {
      return;
    }
    this.pollUpdates().catch((error) => {
      console.error("Telegram bot polling failed:", error.message);
    });
    this.pollTimer = setInterval(() => {
      this.pollUpdates().catch((error) => {
        console.error("Telegram bot polling failed:", error.message);
      });
    }, 1_000);
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollAbortController?.abort();
  }

  async pollUpdates() {
    if (!this.enabled || this.polling) {
      return false;
    }

    this.polling = true;
    const abortController = new AbortController();
    this.pollAbortController = abortController;
    try {
      const response = await this.fetchFn(this.apiUrl("getUpdates"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          offset: this.offset,
          timeout: this.pollTimeoutSeconds,
          allowed_updates: ["message"],
        }),
      });
      if (abortController.signal.aborted) {
        return false;
      }
      if (!response.ok) {
        throw new Error(`Telegram getUpdates failed: ${response.status}`);
      }
      const payload = await response.json();
      for (const update of payload.result ?? []) {
        this.offset = Math.max(this.offset, Number(update.update_id) + 1);
        await this.handleUpdate(update);
      }
      return true;
    } catch (error) {
      if (abortController.signal.aborted || error.name === "AbortError") {
        return false;
      }
      throw error;
    } finally {
      if (this.pollAbortController === abortController) {
        this.pollAbortController = null;
      }
      this.polling = false;
    }
  }

  async handleUpdate(update) {
    const message = update?.message;
    const chatId = Number(message?.chat?.id);
    const text = String(message?.text ?? "").trim();
    if (!chatId || !text) {
      return false;
    }

    const from = message.from ?? {};
    const now = Date.now();
    if (text === "/start") {
      this.store.upsertUser({
        chatId,
        username: from.username ?? "",
        firstName: from.first_name ?? "",
        now,
      });
      await this.sendMessage(chatId, helpText(this.dashboardUrl));
      return true;
    }

    if (!this.store.getUser(chatId)) {
      this.store.upsertUser({
        chatId,
        username: from.username ?? "",
        firstName: from.first_name ?? "",
        now,
      });
    }

    if (text === "/signal") {
      await this.sendMessage(chatId, signalDescriptionText(this.dashboardUrl));
      return true;
    }

    if (text === "/status") {
      await this.sendMessage(chatId, statusText(this.store.getUser(chatId), this.getSignalStats(), this.dashboardUrl));
      return true;
    }

    if (text === "/stop") {
      this.store.disableUser(chatId, now);
      await this.sendMessage(chatId, "TWAP_DRIVER alerts disabled. Use /start to enable again.");
      return true;
    }

    if (text.startsWith("/set") || text.startsWith("/window")) {
      await this.sendMessage(chatId, "Custom threshold/window alerts are disabled. Use /signal for TWAP_DRIVER rules.");
      return true;
    }

    await this.sendMessage(chatId, helpText(this.dashboardUrl));
    return true;
  }

  async handleSnapshot(snapshot) {
    if (!this.enabled || !snapshot?.pressure) {
      return false;
    }

    const sample = sampleFromSnapshot(snapshot);
    if (!sample) {
      return false;
    }

    this.samples.push(sample);
    this.trimSamples(sample.t);
    this.updateSignalOutcomes(sample);

    const signal = detectTwapDriverSignal(this.samples, sample);
    if (!signal) {
      return false;
    }

    let sent = false;
    for (const user of this.store.listEnabledUsers()) {
      if (user.lastAlertAt > 0 && sample.t - user.lastAlertAt < this.cooldownMs) {
        continue;
      }
      await this.sendMessage(user.chatId, formatTwapDriverAlert(signal, this.dashboardUrl));
      this.store.markAlertSent(user.chatId, sample.t);
      sent = true;
    }
    if (sent) {
      this.trackOpenSignal(signal, sample);
    }
    return sent;
  }

  sampleAtOrBefore(timestamp) {
    for (let index = this.samples.length - 1; index >= 0; index -= 1) {
      if (this.samples[index].t <= timestamp) {
        return this.samples[index];
      }
    }
    return null;
  }

  trimSamples(now) {
    const cutoff = now - DRIVER_HISTORY_RETENTION_MS;
    while (this.samples.length && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }

  trackOpenSignal(signal, sample) {
    const tracked = {
      id: `${sample.t}:${signal.side}`,
      side: signal.side,
      entryPrice: sample.price,
      openedAt: sample.t,
      expiresAt: sample.t + DRIVER_MAX_HOLD_MINUTES * 60_000,
    };
    this.openSignals.push(tracked);
    this.store?.recordSignalOpened?.(tracked);
  }

  updateSignalOutcomes(sample) {
    for (const signal of this.openSignals) {
      if (signal.closedAt) {
        continue;
      }
      const moveBp = priceMoveBp(signal.entryPrice, sample.price, signal.side);
      if (moveBp <= -DRIVER_STOP_BP) {
        this.closeTrackedSignal(signal, "SL", -DRIVER_STOP_BP, sample.t);
      } else if (moveBp >= DRIVER_TAKE_PROFIT_BP) {
        this.closeTrackedSignal(signal, "TP", DRIVER_TAKE_PROFIT_BP, sample.t);
      } else if (sample.t >= signal.expiresAt) {
        this.closeTrackedSignal(signal, "TIME", moveBp, sample.t);
      }
    }
    this.openSignals = this.openSignals.filter((signal) => !signal.closedAt);
  }

  closeTrackedSignal(signal, outcome, moveBp, closedAt) {
    signal.closedAt = closedAt;
    this.store?.recordSignalClosed?.({
      id: signal.id,
      outcome,
      moveBp,
      netTakerBp: moveBp - 9,
      netMakerBp: moveBp - 3,
      closedAt,
    });
  }

  async sendMessage(chatId, text) {
    const response = await this.fetchFn(this.apiUrl("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: ${response.status}`);
    }
  }

  apiUrl(method) {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }
}

function helpText(dashboardUrl = DEFAULT_DASHBOARD_URL) {
  return [
    "HYPE TWAP_DRIVER Alert Bot",
    "Commands:",
    "/start - enable TWAP_DRIVER alerts",
    "/stop - disable alerts",
    "/status - current subscription and signal stats",
    "/signal - signal description",
    "",
    "The bot sends only TWAP_DRIVER alerts.",
    `Dashboard: ${dashboardUrl}`,
  ].join("\n");
}

function signalDescriptionText(dashboardUrl = DEFAULT_DASHBOARD_URL) {
  return [
    "TWAP_DRIVER signal",
    "",
    "Looks for a large directed 24h TWAP flow before price has already moved.",
    "",
    "Rules:",
    "q1 = next1h / price",
    "q24 = next24h / price",
    "abs(Δq24 60m) > 80,000 HYPE",
    "q1 and q24 aligned with direction",
    "price not chased: 5m < 10bp, 60m < 80bp",
    "mono24 >= 0.65",
    "premium not overheated",
    "",
    `Plan: SL ${DRIVER_STOP_BP}bp / TP ${DRIVER_TAKE_PROFIT_BP}bp / max hold ${DRIVER_MAX_HOLD_MINUTES}m`,
    `Dashboard: ${dashboardUrl}`,
  ].join("\n");
}

function statusText(user, stats = createSignalStats(), dashboardUrl = DEFAULT_DASHBOARD_URL) {
  if (!user) {
    return "Use /start to enable TWAP_DRIVER alerts.";
  }
  return [
    user.enabled ? "Alerts enabled" : "Alerts disabled",
    "Signal: TWAP_DRIVER",
    `Plan: SL ${DRIVER_STOP_BP}bp / TP ${DRIVER_TAKE_PROFIT_BP}bp / max hold ${DRIVER_MAX_HOLD_MINUTES}m`,
    "",
    `Signals: ${stats.total}`,
    `Open: ${stats.open}`,
    `TP: ${stats.tp}`,
    `SL: ${stats.sl}`,
    `TIME: ${stats.time}`,
    `Net taker: ${formatBp(stats.netTakerBp)}`,
    `Net maker: ${formatBp(stats.netMakerBp)}`,
    `Dashboard: ${dashboardUrl}`,
  ].join("\n");
}

function createSignalStats() {
  return {
    total: 0,
    open: 0,
    tp: 0,
    sl: 0,
    time: 0,
    netTakerBp: 0,
    netMakerBp: 0,
  };
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatSignedHype(value) {
  const prefix = value >= 0 ? "+" : "";
  return `${prefix}${formatMoney(value)} HYPE`;
}

function formatBp(value) {
  const prefix = value >= 0 ? "+" : "";
  return `${prefix}${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value)}bp`;
}

function sampleFromSnapshot(snapshot) {
  const t = Number(snapshot.timestamp) || Date.now();
  const price = Number(snapshot.price);
  const next1h = Number(snapshot.pressure?.next1h);
  const next24h = Number(snapshot.pressure?.next24h);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(next1h) || !Number.isFinite(next24h)) {
    return null;
  }
  return {
    t,
    price,
    q1: next1h / price,
    q24: next24h / price,
    premium: Number(snapshot.perp?.premium),
  };
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

function latestHistoryTimestamp(history) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const timestamp = Number(history[index]?.t);
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return NaN;
}

function detectTwapDriverSignal(samples, current) {
  const previous60m = sampleAtOrBefore(samples, current.t - DRIVER_LOOKBACK_MS);
  const previous5m = sampleAtOrBefore(samples, current.t - DRIVER_PRICE_SHORT_LOOKBACK_MS);
  if (!previous60m || !previous5m) {
    return null;
  }

  const dq24 = current.q24 - previous60m.q24;
  if (!Number.isFinite(dq24) || Math.abs(dq24) <= DRIVER_Q24_THRESHOLD_HYPE) {
    return null;
  }

  const side = Math.sign(dq24);
  if (side * current.q1 <= 0 || side * current.q24 <= 0) {
    return null;
  }

  const priceRet5mBp = priceMoveBp(previous5m.price, current.price, 1);
  const priceRet60mBp = priceMoveBp(previous60m.price, current.price, 1);
  if (side * priceRet5mBp >= DRIVER_MAX_PRICE_5M_BP || side * priceRet60mBp >= DRIVER_MAX_PRICE_60M_BP) {
    return null;
  }

  const mono24 = monotonicity(samples, previous60m.t, current.t, current.q24 - previous60m.q24);
  if (!Number.isFinite(mono24) || mono24 < DRIVER_MIN_MONO) {
    return null;
  }

  const premiumBp = Number.isFinite(current.premium) ? current.premium * 10_000 : null;
  if (premiumBp !== null && side * premiumBp >= DRIVER_MAX_PREMIUM_BP) {
    return null;
  }

  return {
    side,
    sideLabel: side > 0 ? "LONG" : "SHORT",
    dq24,
    q1: current.q1,
    q24: current.q24,
    mono24,
    priceRet5mBp,
    priceRet60mBp,
    premiumBp,
  };
}

function sampleAtOrBefore(samples, timestamp) {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].t <= timestamp) {
      return samples[index];
    }
  }
  return null;
}

function priceMoveBp(entryPrice, currentPrice, side) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(currentPrice)) {
    return NaN;
  }
  return side * (currentPrice / entryPrice - 1) * 10_000;
}

function monotonicity(samples, fromT, toT, netChange) {
  let previous = null;
  let gross = 0;
  for (const sample of samples) {
    if (sample.t < fromT || sample.t > toT) {
      continue;
    }
    if (previous) {
      gross += Math.abs(sample.q24 - previous.q24);
    }
    previous = sample;
  }
  if (!gross) {
    return NaN;
  }
  return Math.abs(netChange) / gross;
}

function formatTwapDriverAlert(signal, dashboardUrl = DEFAULT_DASHBOARD_URL) {
  const premiumLine = signal.premiumBp === null ? "premium: n/a" : `premium: ${formatBp(signal.premiumBp)}`;
  return [
    `TWAP_DRIVER ${signal.sideLabel}`,
    "",
    `Δq24 60m: ${formatSignedHype(signal.dq24)}`,
    `q1: ${formatSignedHype(signal.q1)}`,
    `q24: ${formatSignedHype(signal.q24)}`,
    `mono24: ${signal.mono24.toFixed(2)}`,
    `price 5m: ${formatBp(signal.priceRet5mBp)}`,
    `price 60m: ${formatBp(signal.priceRet60mBp)}`,
    premiumLine,
    "",
    `Plan: SL ${DRIVER_STOP_BP}bp / TP ${DRIVER_TAKE_PROFIT_BP}bp / max hold ${DRIVER_MAX_HOLD_MINUTES}m`,
    `Dashboard: ${dashboardUrl}`,
  ].join("\n");
}
