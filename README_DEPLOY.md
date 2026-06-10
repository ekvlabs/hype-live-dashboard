# HYPE Live Dashboard

Local dashboard for HYPE TWAP pressure and live HYPE price.

## Requirements

- Node.js 20 or newer
- Internet access to:
  - `https://api.hypurrscan.io/twap/*`
  - `https://api.hyperliquid.xyz/info`

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

The app keeps a rolling 7 day history. Every second it saves exactly three chart values:

- `next1h` summed TWAP pressure
- `next24h` summed TWAP pressure
- `price` live HYPE price

By default the history is persisted to:

```text
data/history.ndjson
```

Override it with:

```bash
HISTORY_FILE=/path/to/history.ndjson npm start
```

The browser loads full history once from `/api/snapshot`. After that `/api/events` streams only compact live updates and one new history point per second.

## Telegram Alerts

Telegram alerts are disabled unless both bot credentials and thresholds are configured.

```bash
TELEGRAM_BOT_TOKEN=123:abc \
TELEGRAM_CHAT_ID=123456 \
TELEGRAM_TWAP_1H_THRESHOLD=1000000 \
TELEGRAM_TWAP_24H_THRESHOLD=5000000 \
TELEGRAM_ALERT_COOLDOWN_MS=300000 \
npm start
```

Thresholds are absolute USD values. If `next1h` or `next24h` crosses the configured threshold, the bot sends a `sendMessage` alert and then suppresses repeated alerts for the cooldown window.
