import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class HistoryStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  load({ now = Date.now(), maxHistoryHours = 336, compact = true } = {}) {
    if (!this.filePath || !existsSync(this.filePath)) {
      return [];
    }

    const cutoff = Number(now) - Math.max(1, Number(maxHistoryHours) || 336) * 60 * 60_000;
    const history = [];
    let shouldCompactFile = false;
    forEachLine(readFileSync(this.filePath, "utf8"), (line) => {
      const point = parseLine(line);
      if (!point) {
        shouldCompactFile = shouldCompactFile || Boolean(line.trim());
        return;
      }
      if (Number(point.t) >= cutoff) {
        history.push(point);
      } else {
        shouldCompactFile = true;
      }
    });
    if (compact && shouldCompactFile) {
      this.replace(history);
    }
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

function forEachLine(content, callback) {
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) {
      continue;
    }
    callback(content.slice(start, index));
    start = index + 1;
  }
  if (start < content.length) {
    callback(content.slice(start));
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
