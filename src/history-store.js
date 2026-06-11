import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { trimHistory } from "./history.js";

export class HistoryStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  load({ now = Date.now(), maxHistoryHours = 168 } = {}) {
    if (!this.filePath || !existsSync(this.filePath)) {
      return [];
    }

    const points = readFileSync(this.filePath, "utf8")
      .split("\n")
      .map(parseLine)
      .filter(Boolean);
    const history = trimHistory(points, now, maxHistoryHours);
    this.replace(history);
    return history;
  }

  append(point) {
    const cleanPoint = cleanHistoryPoint(point);
    if (!cleanPoint) {
      return;
    }

    this.ensureDir();
    appendFileSync(this.filePath, `${JSON.stringify(cleanPoint)}\n`, "utf8");
  }

  replace(history) {
    this.ensureDir();
    const content = (history ?? [])
      .map(cleanHistoryPoint)
      .filter(Boolean)
      .map((point) => JSON.stringify(point))
      .join("\n");
    writeFileSync(this.filePath, content ? `${content}\n` : "", "utf8");
  }

  ensureDir() {
    mkdirSync(dirname(this.filePath), { recursive: true });
  }
}

function parseLine(line) {
  const text = line.trim();
  if (!text) {
    return null;
  }

  try {
    return cleanHistoryPoint(JSON.parse(text));
  } catch {
    return null;
  }
}

function cleanHistoryPoint(point) {
  const cleanPoint = {
    t: Number(point?.t),
    price: Number(point?.price),
    next1h: Number(point?.next1h),
    next24h: Number(point?.next24h),
  };

  if (!Object.values(cleanPoint).every(Number.isFinite)) {
    return null;
  }

  for (const key of ["funding", "openInterest", "premium", "markPx", "oraclePx"]) {
    const value = Number(point?.[key]);
    if (Number.isFinite(value)) {
      cleanPoint[key] = value;
    }
  }

  return cleanPoint;
}
