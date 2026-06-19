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
const DRIVER_PENDING_GRACE_MS = 10 * 60 * 1_000;
const DRIVER_PENDING_MAX_PRICE_5M_BP = 30;
const DRIVER_PENDING_MAX_PRICE_60M_BP = 120;
const DRIVER_PENDING_ENTRY_PRICE_5M_BP = DRIVER_MAX_PRICE_5M_BP;
const DRIVER_PENDING_ENTRY_PRICE_60M_BP = DRIVER_PENDING_MAX_PRICE_60M_BP;
const DRIVER_PENDING_FADE_Q24_MULTIPLIER = 0.45;
const DRIVER_MAX_PREMIUM_BP = 8;
const DRIVER_STOP_BP = 20;
const DRIVER_BREAKEVEN_BP = 30;
const DRIVER_TP1_BP = 50;
const DRIVER_WEAK_CHECK_MS = 10 * 60 * 1_000;
const DRIVER_WEAK_MIN_MFE_BP = 20;
const DRIVER_RUNNER_TRAIL_BP = 120;
const DRIVER_FADE_GRACE_MS = 15 * 60 * 1_000;
const DRIVER_MAX_HOLD_MINUTES = 360;
const DRIVER_HISTORY_RETENTION_MS = DRIVER_LOOKBACK_MS + DRIVER_MAX_HOLD_MINUTES * 60_000 + DRIVER_FADE_GRACE_MS + 60_000;
const DRIVER_CONTINUATION_NOTICE_MS = 10 * 60 * 1_000;
const DRIVER_EXTEND_Q24_MULTIPLIER = 1.35;
const DRIVER_FADE_NOTICE_MS = 10 * 60 * 1_000;
const DRIVER_FADE_Q24_MULTIPLIER = 0.45;

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
    this.pendingSignals = this.store?.listPendingSignals?.() ?? [];
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

  signalEvents(options = {}) {
    return {
      items: this.store?.listSignalEvents?.(options) ?? [],
      stats: this.getSignalStats(),
    };
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
      await this.sendMessage(chatId, `TWAP_DRIVER alerts disabled. Use /start to enable again.\nDashboard: ${this.dashboardUrl}`);
      return true;
    }

    if (text.startsWith("/set") || text.startsWith("/window")) {
      await this.sendMessage(
        chatId,
        `Custom threshold/window alerts are disabled. Use /signal for TWAP_DRIVER rules.\nDashboard: ${this.dashboardUrl}`,
      );
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
    const closedNoticeSent = await this.updateSignalOutcomes(sample);
    if (closedNoticeSent) {
      return true;
    }

    const candidate = detectTwapDriverCandidate(this.samples, sample);
    const signal = candidate?.priceEligible ? candidate : null;
    const activeSignal = this.activeSignal();
    if (activeSignal) {
      return this.handleActiveRegime(activeSignal, signal, sample);
    }

    const pendingSignal = this.activePendingSignal();
    if (pendingSignal) {
      return this.handlePendingRegime(pendingSignal, candidate, signal, sample);
    }

    if (!signal) {
      if (shouldOpenPendingSignal(candidate)) {
        this.trackPendingSignal(candidate, sample);
      }
      return false;
    }

    return this.openRegime(signal, sample);
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

  activeSignal() {
    return this.openSignals.find((signal) => !signal.closedAt) ?? null;
  }

  activePendingSignal() {
    return this.pendingSignals.find((signal) => !signal.closedAt) ?? null;
  }

  async openRegime(signal, sample) {
    const tracked = this.trackOpenSignal(signal, sample);
    return this.notifyEnabledUsers(formatTwapDriverEntryAlert(signal, sample, this.dashboardUrl), sample.t, {
      respectCooldown: true,
      markCooldown: true,
    });
  }

  trackOpenSignal(signal, sample) {
    const tracked = {
      id: `${sample.t}:${signal.side}`,
      side: signal.side,
      sideLabel: signal.sideLabel,
      entryPrice: sample.price,
      openedAt: sample.t,
      expiresAt: sample.t + DRIVER_MAX_HOLD_MINUTES * 60_000,
      hitCount: 1,
      lastHitAt: sample.t,
      lastNoticeAt: sample.t,
      mfeBp: 0,
      maeBp: 0,
      entryQ1: signal.q1,
      entryQ24: signal.q24,
      entryDq24: signal.dq24,
      lastQ1: signal.q1,
      lastQ24: signal.q24,
      lastDq24: signal.dq24,
      fadeNotifiedAt: 0,
      phase: "ACTIVE",
      phaseUpdatedAt: sample.t,
      tp1HitAt: 0,
      breakevenHitAt: 0,
      runnerStartedAt: 0,
      weakNotifiedAt: 0,
      trailStopBp: null,
      exitReason: "",
      lastAlignedAt: sample.t,
    };
    this.openSignals.push(tracked);
    this.store?.recordSignalOpened?.({
      ...tracked,
      entryQ1: signal.q1,
      entryQ24: signal.q24,
      entryDq24: signal.dq24,
      lastNoticeAt: sample.t,
      phase: "ACTIVE",
      phaseUpdatedAt: sample.t,
      lastAlignedAt: sample.t,
    });
    return tracked;
  }

  trackPendingSignal(signal, sample) {
    const tracked = {
      id: `${sample.t}:${signal.side}:pending`,
      side: signal.side,
      sideLabel: signal.sideLabel,
      entryPrice: sample.price,
      openedAt: sample.t,
      expiresAt: sample.t + DRIVER_PENDING_GRACE_MS,
      hitCount: 1,
      lastHitAt: sample.t,
      lastNoticeAt: sample.t,
      mfeBp: 0,
      maeBp: 0,
      entryQ1: signal.q1,
      entryQ24: signal.q24,
      entryDq24: signal.dq24,
      lastQ1: signal.q1,
      lastQ24: signal.q24,
      lastDq24: signal.dq24,
      fadeNotifiedAt: 0,
      phase: "PENDING",
      phaseUpdatedAt: sample.t,
      tp1HitAt: 0,
      breakevenHitAt: 0,
      runnerStartedAt: 0,
      weakNotifiedAt: 0,
      trailStopBp: null,
      exitReason: "",
      lastAlignedAt: sample.t,
    };
    this.pendingSignals.push(tracked);
    this.store?.recordSignalOpened?.({
      ...tracked,
      status: "PENDING",
      entryQ1: signal.q1,
      entryQ24: signal.q24,
      entryDq24: signal.dq24,
      lastNoticeAt: sample.t,
      phase: "PENDING",
      phaseUpdatedAt: sample.t,
      lastAlignedAt: sample.t,
    });
    return tracked;
  }

  async handleActiveRegime(activeSignal, signal, sample) {
    if (signal && signal.side !== activeSignal.side) {
      const moveBp = priceMoveBp(activeSignal.entryPrice, sample.price, activeSignal.side);
      this.closeTrackedSignal(activeSignal, "OPPOSITE", moveBp, sample.t, "OPPOSITE_SIGNAL");
      this.openSignals = this.openSignals.filter((tracked) => !tracked.closedAt);
      const exitSent = await this.notifyEnabledUsers(formatTwapDriverExitNotice(activeSignal, "OPPOSITE", moveBp, sample, this.dashboardUrl), sample.t);
      const entrySent = await this.openRegime(signal, sample);
      return exitSent || entrySent;
    }

    this.updateRegimeProgress(activeSignal, sample, signal && signal.side === activeSignal.side ? signal : null);
    const exit = lifecycleExit(activeSignal, sample);
    if (exit) {
      this.closeTrackedSignal(activeSignal, exit.outcome, exit.moveBp, sample.t, exit.reason);
      this.openSignals = this.openSignals.filter((tracked) => !tracked.closedAt);
      return this.notifyEnabledUsers(formatTwapDriverExitNotice(activeSignal, exit.outcome, exit.moveBp, sample, this.dashboardUrl), sample.t);
    }

    const phaseNotice = lifecyclePhaseNotice(activeSignal, signal, sample);
    if (phaseNotice) {
      this.applyPhaseNotice(activeSignal, phaseNotice, sample);
      return this.notifyEnabledUsers(formatTwapDriverPhaseNotice(activeSignal, phaseNotice, signal, sample, this.dashboardUrl), sample.t);
    }

    if (signal && signal.side === activeSignal.side) {
      const noticeType = continuationNoticeType(activeSignal, signal, sample);
      if (!noticeType) {
        return false;
      }
      this.applyPhaseNotice(activeSignal, { phase: activeSignal.phase || "ACTIVE", noticeType }, sample);
      return this.notifyEnabledUsers(formatTwapDriverContinuationNotice(activeSignal, noticeType, signal, sample, this.dashboardUrl), sample.t);
    }

    if (shouldNotifyFade(activeSignal, sample)) {
      this.applyPhaseNotice(activeSignal, { phase: "FADE", noticeType: "FADE", fadeNotifiedAt: sample.t }, sample);
      return this.notifyEnabledUsers(formatTwapDriverFadeNotice(activeSignal, sample, this.dashboardUrl), sample.t);
    }

    return false;
  }

  async handlePendingRegime(pendingSignal, candidate, signal, sample) {
    if (sample.t >= Number(pendingSignal.expiresAt)) {
      this.closePendingSignal(pendingSignal, "CANCELLED", sample.t, "PENDING_TIMEOUT");
      this.pendingSignals = this.pendingSignals.filter((tracked) => !tracked.closedAt);
      return false;
    }

    if (candidate && candidate.side === pendingSignal.side) {
      updatePendingProgress(pendingSignal, candidate, sample);
      if (signal || shouldConvertPendingSignal(candidate)) {
        this.closePendingSignal(pendingSignal, "CONVERTED", sample.t, "PENDING_CONVERTED");
        this.pendingSignals = this.pendingSignals.filter((tracked) => !tracked.closedAt);
        return this.openRegime(candidate, sample);
      }
    }

    if (candidate && candidate.side !== pendingSignal.side) {
      this.closePendingSignal(pendingSignal, "CANCELLED", sample.t, "PENDING_OPPOSITE");
      this.pendingSignals = this.pendingSignals.filter((tracked) => !tracked.closedAt);
      if (signal) {
        return this.openRegime(signal, sample);
      }
      if (shouldOpenPendingSignal(candidate)) {
        this.trackPendingSignal(candidate, sample);
      }
      return false;
    }

    if (shouldCancelPendingPressure(pendingSignal, sample)) {
      this.closePendingSignal(pendingSignal, "CANCELLED", sample.t, "PENDING_FADE");
      this.pendingSignals = this.pendingSignals.filter((tracked) => !tracked.closedAt);
    }

    return false;
  }

  closePendingSignal(signal, outcome, closedAt, exitReason = "") {
    signal.closedAt = closedAt;
    signal.exitReason = exitReason;
    signal.phase = "FINAL_EXIT";
    this.store?.recordPendingClosed?.({
      id: signal.id,
      outcome,
      closedAt,
      exitReason,
    });
  }

  async updateSignalOutcomes(sample) {
    let sent = false;
    for (const signal of this.openSignals) {
      if (signal.closedAt) {
        continue;
      }
      this.updateRegimeProgress(signal, sample, null);
      const moveBp = priceMoveBp(signal.entryPrice, sample.price, signal.side);
      if (moveBp <= -DRIVER_STOP_BP) {
        this.closeTrackedSignal(signal, "SL", -DRIVER_STOP_BP, sample.t, "HARD_SL");
        sent = (await this.notifyEnabledUsers(formatTwapDriverExitNotice(signal, "SL", -DRIVER_STOP_BP, sample, this.dashboardUrl), sample.t)) || sent;
      } else if (sample.t >= signal.expiresAt) {
        const outcome = moveBp > 0 ? "TP" : "TIME";
        this.closeTrackedSignal(signal, outcome, moveBp, sample.t, "MAX_HOLD");
        sent = (await this.notifyEnabledUsers(formatTwapDriverExitNotice(signal, outcome, moveBp, sample, this.dashboardUrl), sample.t)) || sent;
      }
    }
    this.openSignals = this.openSignals.filter((signal) => !signal.closedAt);
    return sent;
  }

  updateRegimeProgress(signal, sample, detectedSignal) {
    const moveBp = priceMoveBp(signal.entryPrice, sample.price, signal.side);
    if (Number.isFinite(moveBp)) {
      signal.mfeBp = roundBp(Math.max(Number(signal.mfeBp) || 0, moveBp));
      signal.maeBp = roundBp(Math.min(Number(signal.maeBp) || 0, moveBp));
      if (Number(signal.tp1HitAt) > 0) {
        const nextTrailStop = roundBp(Math.max(0, signal.mfeBp - DRIVER_RUNNER_TRAIL_BP));
        signal.trailStopBp = Math.max(Number(signal.trailStopBp) || 0, nextTrailStop);
      }
    }

    if (isPressureAligned(signal, sample)) {
      signal.lastAlignedAt = sample.t;
    }

    if (detectedSignal) {
      signal.hitCount = (Number(signal.hitCount) || 1) + 1;
      signal.lastHitAt = sample.t;
      signal.lastQ1 = detectedSignal.q1;
      signal.lastQ24 = detectedSignal.q24;
      signal.lastDq24 = detectedSignal.dq24;
    }

    this.store?.recordSignalProgress?.({
      id: signal.id,
      hitCount: signal.hitCount,
      lastHitAt: signal.lastHitAt,
      mfeBp: signal.mfeBp,
      maeBp: signal.maeBp,
      lastQ1: signal.lastQ1,
      lastQ24: signal.lastQ24,
      lastDq24: signal.lastDq24,
      trailStopBp: signal.trailStopBp,
      lastAlignedAt: signal.lastAlignedAt,
    });
  }

  applyPhaseNotice(signal, notice, sample) {
    signal.phase = notice.phase || signal.phase || "ACTIVE";
    signal.phaseUpdatedAt = sample.t;
    signal.lastNoticeAt = sample.t;
    if (notice.tp1HitAt) {
      signal.tp1HitAt = notice.tp1HitAt;
    }
    if (notice.breakevenHitAt) {
      signal.breakevenHitAt = notice.breakevenHitAt;
    }
    if (notice.runnerStartedAt) {
      signal.runnerStartedAt = notice.runnerStartedAt;
    }
    if (notice.weakNotifiedAt) {
      signal.weakNotifiedAt = notice.weakNotifiedAt;
    }
    if (notice.fadeNotifiedAt) {
      signal.fadeNotifiedAt = notice.fadeNotifiedAt;
    }
    if (Number.isFinite(Number(notice.trailStopBp))) {
      signal.trailStopBp = Number(notice.trailStopBp);
    }
    this.store?.recordSignalProgress?.({
      id: signal.id,
      hitCount: signal.hitCount,
      lastHitAt: signal.lastHitAt,
      lastNoticeAt: signal.lastNoticeAt,
      mfeBp: signal.mfeBp,
      maeBp: signal.maeBp,
      lastQ1: signal.lastQ1,
      lastQ24: signal.lastQ24,
      lastDq24: signal.lastDq24,
      fadeNotifiedAt: signal.fadeNotifiedAt,
      phase: signal.phase,
      phaseUpdatedAt: signal.phaseUpdatedAt,
      tp1HitAt: signal.tp1HitAt,
      breakevenHitAt: signal.breakevenHitAt,
      runnerStartedAt: signal.runnerStartedAt,
      weakNotifiedAt: signal.weakNotifiedAt,
      trailStopBp: signal.trailStopBp,
      lastAlignedAt: signal.lastAlignedAt,
    });
  }

  closeTrackedSignal(signal, outcome, moveBp, closedAt, exitReason = "") {
    signal.closedAt = closedAt;
    signal.exitReason = exitReason;
    signal.phase = "FINAL_EXIT";
    this.store?.recordSignalClosed?.({
      id: signal.id,
      outcome,
      moveBp,
      netTakerBp: moveBp - 9,
      netMakerBp: moveBp - 3,
      closedAt,
      exitReason,
    });
  }

  async notifyEnabledUsers(text, now, { respectCooldown = false, markCooldown = false } = {}) {
    let sent = false;
    for (const user of this.store.listEnabledUsers()) {
      if (respectCooldown && user.lastAlertAt > 0 && now - user.lastAlertAt < this.cooldownMs) {
        continue;
      }
      await this.sendMessage(user.chatId, text);
      if (markCooldown) {
        this.store.markAlertSent(user.chatId, now);
      }
      sent = true;
    }
    return sent;
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
    "PENDING_DRIVER:",
    "If a large TWAP arrives after price has already started moving, the dashboard marks it as pending for 10m.",
    "Pending is converted to ENTRY only if short-term price cools while TWAP pressure remains aligned.",
    "Pending markers are chart context only; Telegram alerts are sent only after a real ENTRY.",
    "",
    "Lifecycle:",
    "ENTRY -> ACTIVE by default",
    `hard SL ${DRIVER_STOP_BP}bp`,
    `weak close if MFE < ${DRIVER_WEAK_MIN_MFE_BP}bp after ${formatMinutes(DRIVER_WEAK_CHECK_MS)}`,
    `BE after +${DRIVER_BREAKEVEN_BP}bp`,
    `TP1 +${DRIVER_TP1_BP}bp, then runner while TWAP pressure stays aligned`,
    `fade timeout ${formatMinutes(DRIVER_FADE_GRACE_MS)} after pressure weakens`,
    `max regime ${DRIVER_MAX_HOLD_MINUTES}m`,
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
    `Plan: hard SL ${DRIVER_STOP_BP}bp / weak ${formatMinutes(DRIVER_WEAK_CHECK_MS)} / BE +${DRIVER_BREAKEVEN_BP}bp / TP1 +${DRIVER_TP1_BP}bp / max ${DRIVER_MAX_HOLD_MINUTES}m`,
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

function detectTwapDriverCandidate(samples, current) {
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
  const priceEligible = side * priceRet5mBp < DRIVER_MAX_PRICE_5M_BP && side * priceRet60mBp < DRIVER_MAX_PRICE_60M_BP;

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
    priceEligible,
  };
}

function shouldOpenPendingSignal(candidate) {
  if (!candidate || candidate.priceEligible) {
    return false;
  }
  return (
    candidate.side * candidate.priceRet5mBp < DRIVER_PENDING_MAX_PRICE_5M_BP &&
    candidate.side * candidate.priceRet60mBp < DRIVER_PENDING_MAX_PRICE_60M_BP
  );
}

function shouldConvertPendingSignal(candidate) {
  if (!candidate) {
    return false;
  }
  return (
    candidate.side * candidate.priceRet5mBp < DRIVER_PENDING_ENTRY_PRICE_5M_BP &&
    candidate.side * candidate.priceRet60mBp < DRIVER_PENDING_ENTRY_PRICE_60M_BP
  );
}

function updatePendingProgress(pendingSignal, candidate, sample) {
  pendingSignal.hitCount = (Number(pendingSignal.hitCount) || 1) + 1;
  pendingSignal.lastHitAt = sample.t;
  pendingSignal.lastQ1 = candidate.q1;
  pendingSignal.lastQ24 = candidate.q24;
  pendingSignal.lastDq24 = candidate.dq24;
  if (candidate.side * sample.q24 > 0) {
    pendingSignal.lastAlignedAt = sample.t;
  }
}

function shouldCancelPendingPressure(pendingSignal, sample) {
  const side = Number(pendingSignal.side);
  if (side * Number(sample.q1) <= 0 || side * Number(sample.q24) <= 0) {
    return true;
  }
  const entryQ24 = Math.max(1, Math.abs(Number(pendingSignal.entryQ24) || 0));
  return Math.abs(Number(sample.q24) || 0) <= entryQ24 * DRIVER_PENDING_FADE_Q24_MULTIPLIER;
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

function roundBp(value) {
  return Number(Number(value).toFixed(6));
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

function continuationNoticeType(activeSignal, signal, sample) {
  if (sample.t - Number(activeSignal.lastNoticeAt) < DRIVER_CONTINUATION_NOTICE_MS) {
    return "";
  }

  if (["TP1", "RUNNER", "FADE"].includes(String(activeSignal.phase || "").toUpperCase())) {
    return "";
  }

  const entryQ24 = Math.max(1, Math.abs(Number(activeSignal.entryQ24) || 0));
  if (Math.abs(signal.q24) >= entryQ24 * DRIVER_EXTEND_Q24_MULTIPLIER) {
    return "EXTEND";
  }
  return "HOLD";
}

function lifecycleExit(activeSignal, sample) {
  const moveBp = priceMoveBp(activeSignal.entryPrice, sample.price, activeSignal.side);
  if (!Number.isFinite(moveBp)) {
    return null;
  }

  if (moveBp <= -DRIVER_STOP_BP) {
    return { outcome: "SL", moveBp: -DRIVER_STOP_BP, reason: "HARD_SL" };
  }

  if (Number(activeSignal.breakevenHitAt) > 0 && moveBp <= 0) {
    return { outcome: "TIME", moveBp: 0, reason: "BREAKEVEN_STOP" };
  }

  if (
    Number(activeSignal.tp1HitAt) > 0 &&
    Number.isFinite(Number(activeSignal.trailStopBp)) &&
    moveBp <= Number(activeSignal.trailStopBp)
  ) {
    const trailMove = Math.max(0, Number(activeSignal.trailStopBp));
    return { outcome: trailMove > 0 ? "TP" : "TIME", moveBp: trailMove, reason: "TRAIL" };
  }

  if (
    Number(activeSignal.weakNotifiedAt) <= 0 &&
    sample.t - Number(activeSignal.openedAt) >= DRIVER_WEAK_CHECK_MS &&
    Number(activeSignal.mfeBp) < DRIVER_WEAK_MIN_MFE_BP
  ) {
    return { outcome: moveBp > 0 ? "TIME" : "SL", moveBp: roundBp(moveBp), reason: "WEAK_TIMEOUT" };
  }

  if (Number(activeSignal.fadeNotifiedAt) > 0 && sample.t - Number(activeSignal.fadeNotifiedAt) >= DRIVER_FADE_GRACE_MS) {
    return { outcome: moveBp > 0 ? "TP" : "TIME", moveBp: roundBp(moveBp), reason: "FADE_TIMEOUT" };
  }

  if (sample.t >= Number(activeSignal.expiresAt)) {
    return { outcome: moveBp > 0 ? "TP" : "TIME", moveBp: roundBp(moveBp), reason: "MAX_HOLD" };
  }

  return null;
}

function lifecyclePhaseNotice(activeSignal, signal, sample) {
  const moveBp = priceMoveBp(activeSignal.entryPrice, sample.price, activeSignal.side);
  if (!Number.isFinite(moveBp)) {
    return null;
  }

  if (Number(activeSignal.tp1HitAt) <= 0 && moveBp >= DRIVER_TP1_BP) {
    const trailStopBp = Math.max(0, roundBp((Number(activeSignal.mfeBp) || moveBp) - DRIVER_RUNNER_TRAIL_BP));
    return {
      phase: "TP1",
      noticeType: "TP1",
      tp1HitAt: sample.t,
      breakevenHitAt: Number(activeSignal.breakevenHitAt) || sample.t,
      runnerStartedAt: sample.t,
      trailStopBp,
    };
  }

  if (Number(activeSignal.breakevenHitAt) <= 0 && moveBp >= DRIVER_BREAKEVEN_BP) {
    return {
      phase: "BE",
      noticeType: "BE",
      breakevenHitAt: sample.t,
      trailStopBp: 0,
    };
  }

  if (shouldNotifyFade(activeSignal, sample)) {
    return {
      phase: "FADE",
      noticeType: "FADE",
      fadeNotifiedAt: sample.t,
    };
  }

  return null;
}

function shouldNotifyFade(activeSignal, sample) {
  if (Number(activeSignal.fadeNotifiedAt) > 0) {
    return false;
  }
  if (sample.t - Number(activeSignal.openedAt) < DRIVER_FADE_NOTICE_MS) {
    return false;
  }

  const entryQ24 = Math.max(1, Math.abs(Number(activeSignal.entryQ24) || 0));
  return activeSignal.side * sample.q24 <= entryQ24 * DRIVER_FADE_Q24_MULTIPLIER;
}

function isPressureAligned(activeSignal, sample) {
  return Number(activeSignal.side) * Number(sample.q24) > 0;
}

function formatTwapDriverEntryAlert(signal, sample, dashboardUrl = DEFAULT_DASHBOARD_URL) {
  const premiumLine = signal.premiumBp === null ? "premium: n/a" : `premium: ${formatBp(signal.premiumBp)}`;
  return [
    `TWAP_DRIVER ENTRY ${signal.sideLabel}`,
    "",
    `Entry: ${formatPrice(sample.price)}`,
    "Status: ACTIVE",
    `Δq24 60m: ${formatSignedHype(signal.dq24)}`,
    `q1: ${formatSignedHype(signal.q1)}`,
    `q24: ${formatSignedHype(signal.q24)}`,
    `mono24: ${signal.mono24.toFixed(2)}`,
    `price 5m: ${formatBp(signal.priceRet5mBp)}`,
    `price 60m: ${formatBp(signal.priceRet60mBp)}`,
    premiumLine,
    "",
    `Plan: hard SL ${DRIVER_STOP_BP}bp / weak ${formatMinutes(DRIVER_WEAK_CHECK_MS)} / BE +${DRIVER_BREAKEVEN_BP}bp / TP1 +${DRIVER_TP1_BP}bp / max ${DRIVER_MAX_HOLD_MINUTES}m`,
    `Dashboard: ${dashboardUrl}`,
  ].join("\n");
}

function formatTwapDriverPhaseNotice(activeSignal, notice, signal, sample, dashboardUrl = DEFAULT_DASHBOARD_URL) {
  const moveBp = priceMoveBp(activeSignal.entryPrice, sample.price, activeSignal.side);
  const type = notice.noticeType || notice.phase;
  const lines = [
    `TWAP_DRIVER ${type} ${activeSignal.sideLabel ?? sideLabel(activeSignal.side)}`,
    "",
    `Entry: ${formatPrice(activeSignal.entryPrice)}`,
    `Now: ${formatPrice(sample.price)} (${formatBp(moveBp)})`,
    `Position age: ${formatMinutes(sample.t - activeSignal.openedAt)}`,
    `MFE: ${formatBp(activeSignal.mfeBp)}`,
    `MAE: ${formatBp(activeSignal.maeBp)}`,
    `Hits: ${activeSignal.hitCount}`,
  ];

  if (type === "BE") {
    lines.push("", "Action: move stop to breakeven. Keep position only while TWAP pressure remains aligned.");
  } else if (type === "TP1") {
    lines.push(
      "",
      "Action: TP1 reached. Take partial if needed, move stop to breakeven, keep runner while TWAP pressure remains aligned.",
      `Runner trail: ${formatBp(activeSignal.trailStopBp ?? notice.trailStopBp ?? 0)}`,
    );
  } else if (type === "FADE") {
    lines.push(
      "",
      `Action: pressure weakened. Tighten stop or set take-profit; bot will close the regime after ${formatMinutes(DRIVER_FADE_GRACE_MS)} if pressure does not recover.`,
    );
  }

  if (signal) {
    lines.push("", `Δq24 60m: ${formatSignedHype(signal.dq24)}`, `q1: ${formatSignedHype(signal.q1)}`, `q24: ${formatSignedHype(signal.q24)}`);
  } else {
    lines.push("", `q1 now: ${formatSignedHype(sample.q1)}`, `q24 now: ${formatSignedHype(sample.q24)}`);
  }

  lines.push(`Dashboard: ${dashboardUrl}`);
  return lines.join("\n");
}

function formatTwapDriverContinuationNotice(activeSignal, noticeType, signal, sample, dashboardUrl = DEFAULT_DASHBOARD_URL) {
  const moveBp = priceMoveBp(activeSignal.entryPrice, sample.price, activeSignal.side);
  return [
    `TWAP_DRIVER ${noticeType} ${activeSignal.sideLabel ?? sideLabel(activeSignal.side)}`,
    "",
    `Position age: ${formatMinutes(sample.t - activeSignal.openedAt)}`,
    `Move from entry: ${formatBp(moveBp)}`,
    `MFE: ${formatBp(activeSignal.mfeBp)}`,
    `MAE: ${formatBp(activeSignal.maeBp)}`,
    `Hits: ${activeSignal.hitCount}`,
    "",
    `Δq24 60m: ${formatSignedHype(signal.dq24)}`,
    `q1: ${formatSignedHype(signal.q1)}`,
    `q24: ${formatSignedHype(signal.q24)}`,
    "",
    noticeType === "EXTEND"
      ? "Action: pressure increased; hold can be extended instead of treating this as a new entry."
      : "Action: pressure remains aligned; keep managing the existing position.",
    `Dashboard: ${dashboardUrl}`,
  ].join("\n");
}

function formatTwapDriverFadeNotice(activeSignal, sample, dashboardUrl = DEFAULT_DASHBOARD_URL) {
  const moveBp = priceMoveBp(activeSignal.entryPrice, sample.price, activeSignal.side);
  return [
    `TWAP_DRIVER FADE ${activeSignal.sideLabel ?? sideLabel(activeSignal.side)}`,
    "",
    `Position age: ${formatMinutes(sample.t - activeSignal.openedAt)}`,
    `Move from entry: ${formatBp(moveBp)}`,
    `q24 now: ${formatSignedHype(sample.q24)}`,
    "",
    `Action: TWAP pressure weakened; tighten stop or set take-profit. Fade timeout: ${formatMinutes(DRIVER_FADE_GRACE_MS)}.`,
    `Dashboard: ${dashboardUrl}`,
  ].join("\n");
}

function formatTwapDriverExitNotice(activeSignal, outcome, moveBp, sample, dashboardUrl = DEFAULT_DASHBOARD_URL) {
  return [
    `TWAP_DRIVER EXIT ${activeSignal.sideLabel ?? sideLabel(activeSignal.side)} - ${outcome}`,
    "",
    `Entry: ${formatPrice(activeSignal.entryPrice)}`,
    `Exit: ${formatPrice(sample.price)}`,
    `Result: ${formatBp(moveBp)}`,
    `Reason: ${activeSignal.exitReason || outcome}`,
    `Net taker: ${formatBp(moveBp - 9)}`,
    `Net maker: ${formatBp(moveBp - 3)}`,
    `Hold: ${formatMinutes(sample.t - activeSignal.openedAt)}`,
    `MFE: ${formatBp(activeSignal.mfeBp)}`,
    `MAE: ${formatBp(activeSignal.maeBp)}`,
    `Hits: ${activeSignal.hitCount}`,
    `Dashboard: ${dashboardUrl}`,
  ].join("\n");
}

function sideLabel(side) {
  return Number(side) > 0 ? "LONG" : "SHORT";
}

function formatPrice(value) {
  return `$${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)}`;
}

function formatMinutes(ms) {
  return `${Math.max(0, Math.round(Number(ms) / 60_000))}m`;
}
