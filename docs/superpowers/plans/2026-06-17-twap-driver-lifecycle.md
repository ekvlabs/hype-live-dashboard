# TWAP Driver Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram TWAP_DRIVER alerts manage one active pressure regime instead of closing the whole idea at the first fixed TP.

**Architecture:** Keep `telegram_signal_events.status` as the final trade outcome (`OPEN`, `TP`, `SL`, `TIME`, `OPPOSITE`, etc.) and add separate lifecycle phase fields for live management (`ENTRY`, `ACTIVE`, `WEAK`, `BE`, `TP1`, `RUNNER`, `FADE`). Repeat same-side detections update the same regime. The bot sends phase-change instructions and final result messages.

**Tech Stack:** Node.js 22, built-in `node:sqlite`, `node --test`, existing Telegram bot and chart event API.

---

### Task 1: Add Lifecycle Persistence

**Files:**
- Modify: `src/bot-store.js`
- Test: `test/bot-store.test.js`

- [ ] Add columns: `phase`, `phase_updated_at`, `tp1_hit_at`, `breakeven_hit_at`, `runner_started_at`, `weak_notified_at`, `trail_stop_bp`, `exit_reason`.
- [ ] Extend `recordSignalOpened`, `recordSignalProgress`, `listOpenSignals`, and public events to preserve the new fields.
- [ ] Verify existing rows migrate with defaults and old statistics remain intact.

### Task 2: Add Regime Lifecycle Tests

**Files:**
- Modify: `test/telegram-alert-bot.test.js`

- [ ] Test that fixed +126bp no longer closes the regime immediately; it sends TP1/RUNNER and keeps one open signal while pressure remains aligned.
- [ ] Test that weak regimes close if they fail to reach +20bp MFE after 10 minutes.
- [ ] Test that after TP1 the bot moves to BE/RUNNER and closes by trailing or fade, then reports final result.
- [ ] Test that `/signal` describes the lifecycle, not the old fixed TP-only plan.

### Task 3: Implement Bot State Machine

**Files:**
- Modify: `src/telegram-alert-bot.js`

- [ ] Replace fixed full-take-profit exit with lifecycle thresholds:
  - hard SL `20bp`
  - weak timeout after `10m` if MFE `<20bp`
  - BE phase after `+30bp`
  - TP1 phase after `+50bp`
  - runner trail after TP1
  - fade when q24 weakens or alignment is lost
- [ ] Keep same-side hits as one managed regime.
- [ ] Close regime only on hard SL, weak timeout, trail/fade/time, or opposite signal.

### Task 4: Update Bot Messages

**Files:**
- Modify: `src/telegram-alert-bot.js`

- [ ] Entry message includes entry price and lifecycle plan.
- [ ] Phase notices include suggested action, suggested stop/TP, age, MFE/MAE, q1/q24.
- [ ] Final exit includes entry, exit, result, net taker/maker, hold, MFE/MAE, hits.
- [ ] `/signal` explains ENTRY -> ACTIVE -> WEAK/BE/TP1/RUNNER/FADE -> FINAL_EXIT.

### Task 5: Verify and Deploy

**Files:**
- Modify only files above unless tests require a narrow public event assertion update.

- [ ] Run focused tests for bot store and Telegram bot.
- [ ] Run full `npm test`.
- [ ] Commit and push.
- [ ] Deploy on VPS with `scripts/deploy-update.sh` or equivalent safe pull/restart.
- [ ] Verify service is active and API returns live state.
