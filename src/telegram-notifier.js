const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export class TelegramNotifier {
  constructor({
    botToken,
    chatId,
    twap1hThreshold,
    twap24hThreshold,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    fetchFn = globalThis.fetch,
  } = {}) {
    this.botToken = botToken || "";
    this.chatId = chatId || "";
    this.twap1hThreshold = parseOptionalNumber(twap1hThreshold);
    this.twap24hThreshold = parseOptionalNumber(twap24hThreshold);
    this.cooldownMs = Number(cooldownMs) || DEFAULT_COOLDOWN_MS;
    this.fetchFn = fetchFn;
    this.lastSentAt = new Map();
  }

  static fromEnv(env = process.env) {
    return new TelegramNotifier({
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
      twap1hThreshold: env.TELEGRAM_TWAP_1H_THRESHOLD,
      twap24hThreshold: env.TELEGRAM_TWAP_24H_THRESHOLD,
      cooldownMs: env.TELEGRAM_ALERT_COOLDOWN_MS,
    });
  }

  get enabled() {
    return Boolean(this.botToken && this.chatId);
  }

  async handleSnapshot(snapshot) {
    if (!this.enabled || !snapshot?.pressure) {
      return false;
    }

    const now = Number(snapshot.timestamp) || Date.now();
    const alerts = [
      this.alertFor("twap1h", "TWAP 1h", snapshot.pressure.next1h, this.twap1hThreshold, now),
      this.alertFor("twap24h", "TWAP 24h", snapshot.pressure.next24h, this.twap24hThreshold, now),
    ].filter(Boolean);

    if (!alerts.length) {
      return false;
    }

    await this.sendMessage(["HYPE alert", ...alerts].join("\n"));
    return true;
  }

  alertFor(key, label, value, threshold, now) {
    const number = Number(value);
    if (!Number.isFinite(number) || !Number.isFinite(threshold) || Math.abs(number) < threshold) {
      return null;
    }

    const lastSentAt = this.lastSentAt.get(key) ?? -Infinity;
    if (now - lastSentAt < this.cooldownMs) {
      return null;
    }

    this.lastSentAt.set(key, now);
    return `${label}: ${formatSigned(number)}$`;
  }

  async sendMessage(text) {
    const response = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: ${response.status}`);
    }
  }
}

function parseOptionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatSigned(value) {
  const prefix = value >= 0 ? "+" : "";
  return `${prefix}${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value)}`;
}
