# HYPE Live Dashboard

Local dashboard for HYPE TWAP pressure and live HYPE price.

## Requirements

- Node.js 20 or newer
- Internet access to:
- `https://api.hypurrscan.io/twap/*`
- `https://api.hyperliquid.xyz/info`
- `wss://api.hyperliquid.xyz/ws`

## Install

```bash
npm ci
```

## Run

```bash
npm start
```

Open:

```text
http://127.0.0.1:4173/
```

Optional port/host override:

```bash
PORT=4174 HOST=127.0.0.1 npm start
```

For a public VM, bind to all interfaces behind a firewall or reverse proxy:

```bash
HOST=0.0.0.0 PORT=4173 npm start
```

## Verify

```bash
npm test
```

## What It Stores

The app keeps a rolling 14 day history. Every second it saves the core chart values:

- `next1h` summed TWAP pressure
- `next24h` summed TWAP pressure
- `price` live HYPE price

When Hyperliquid perp context is available, the same history point also includes:

- `funding`
- `openInterest`
- `premium`
- `markPx`
- `oraclePx`

Older history rows without these optional fields remain valid.

By default the history is persisted to:

```text
data/history.ndjson
```

Override it with:

```bash
HISTORY_FILE=/path/to/history.ndjson npm start
```

The browser loads only the visible history window from `/api/history?hours=...&resolution=...`. Large windows are automatically compacted to a safe effective resolution so the API does not send the full two-week raw log to every browser. Live state is then polled from `/api/state` once per second and appended one chart point per tick.

Request analytics are stored in SQLite:

```text
data/analytics.sqlite
```

Override it with:

```bash
ANALYTICS_DB=/path/to/analytics.sqlite npm start
```

Aggregates are available at `/api/analytics`.

## Telegram Bot

Telegram bot alerts are disabled unless a bot token is configured.

```bash
TELEGRAM_BOT_TOKEN=123:abc \
TELEGRAM_BOT_DB=/path/to/bot.sqlite \
TELEGRAM_ALERT_COOLDOWN_MS=1800000 \
npm start
```

The bot sends only `TWAP_DRIVER` alerts. `TELEGRAM_ALERT_COOLDOWN_MS` suppresses repeated alerts per user while the same market regime remains active; the production default should stay at 30 minutes unless you intentionally want high-frequency test alerts.
