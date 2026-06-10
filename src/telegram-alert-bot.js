import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BotStore } from "./bot-store.js";

const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_DB_PATH = join(fileURLToPath(new URL("..", import.meta.url)), "data", "bot.sqlite");
const SUPPORTED_WINDOWS = new Set([5, 15]);

export class TelegramAlertBot {
  constructor({
    botToken,
    store,
    fetchFn = globalThis.fetch,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    pollTimeoutSeconds = 25,
  } = {}) {
    this.botToken = botToken || "";
    this.store = store;
    this.fetchFn = fetchFn;
    this.cooldownMs = Number(cooldownMs) || DEFAULT_COOLDOWN_MS;
    this.pollTimeoutSeconds = pollTimeoutSeconds;
    this.offset = 0;
    this.samples = [];
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
    });
  }

  get enabled() {
    return Boolean(this.botToken && this.store);
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
      await this.sendMessage(chatId, helpText());
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

    if (text.startsWith("/set")) {
      const threshold = parsePositiveNumber(text.split(/\s+/)[1]);
      if (!threshold) {
        await this.sendMessage(chatId, "Use /set 500000");
        return false;
      }
      this.store.setThreshold(chatId, threshold, now);
      await this.sendMessage(chatId, `Alert threshold: ${formatMoney(threshold)}$`);
      return true;
    }

    if (text.startsWith("/window")) {
      const windowSeconds = Number(text.split(/\s+/)[1]);
      if (!SUPPORTED_WINDOWS.has(windowSeconds)) {
        await this.sendMessage(chatId, "Use /window 5 or /window 15");
        return false;
      }
      this.store.setWindowSeconds(chatId, windowSeconds, now);
      await this.sendMessage(chatId, `Alert window: ${windowSeconds}s`);
      return true;
    }

    if (text === "/status") {
      await this.sendMessage(chatId, statusText(this.store.getUser(chatId)));
      return true;
    }

    if (text === "/stop") {
      this.store.disableUser(chatId, now);
      await this.sendMessage(chatId, "Alerts disabled. Use /start to enable again.");
      return true;
    }

    await this.sendMessage(chatId, helpText());
    return true;
  }

  async handleSnapshot(snapshot) {
    if (!this.enabled || !snapshot?.pressure) {
      return false;
    }

    const sample = {
      t: Number(snapshot.timestamp) || Date.now(),
      next1h: Number(snapshot.pressure.next1h),
    };
    if (!Number.isFinite(sample.next1h)) {
      return false;
    }

    this.samples.push(sample);
    this.trimSamples(sample.t);

    let sent = false;
    for (const user of this.store.listEnabledUsers()) {
      const previous = this.sampleAtOrBefore(sample.t - user.windowSeconds * 1_000);
      if (!previous) {
        continue;
      }
      const delta = sample.next1h - previous.next1h;
      if (
        Math.abs(delta) < user.threshold ||
        (user.lastAlertAt > 0 && sample.t - user.lastAlertAt < this.cooldownMs)
      ) {
        continue;
      }
      await this.sendMessage(
        user.chatId,
        `HYPE alert\nTWAP 1h: ${formatSigned(delta)}$ in ${user.windowSeconds}s\nCurrent: ${formatSigned(sample.next1h)}$`,
      );
      this.store.markAlertSent(user.chatId, sample.t);
      sent = true;
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
    const cutoff = now - 60_000;
    while (this.samples.length && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
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

function helpText() {
  return [
    "HYPE Alert Bot",
    "Commands:",
    "/set 500000 - TWAP 1h delta threshold",
    "/window 5 - alert window, 5 or 15 seconds",
    "/status - current settings",
    "/stop - disable alerts",
  ].join("\n");
}

function statusText(user) {
  if (!user) {
    return "Use /start to enable alerts.";
  }
  return [
    user.enabled ? "Alerts enabled" : "Alerts disabled",
    `Threshold: ${formatMoney(user.threshold)}$`,
    `Window: ${user.windowSeconds}s`,
  ].join("\n");
}

function parsePositiveNumber(value) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatSigned(value) {
  const prefix = value >= 0 ? "+" : "";
  return `${prefix}${formatMoney(value)}`;
}
