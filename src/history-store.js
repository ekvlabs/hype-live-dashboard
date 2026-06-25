import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import {
  emptyHistoryPayload,
  historyPayloadQuery,
  historyPayloadResponse,
} from "./events.js";

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

  async payload({ config = {}, options = {} } = {}) {
    const latestTimestamp = this.latestTimestamp();
    if (!Number.isFinite(latestTimestamp)) {
      return emptyHistoryPayload(config, options);
    }

    const query = historyPayloadQuery(config, options, latestTimestamp);
    const history = await this.compactedWindow({
      from: query.from,
      to: query.latestTimestamp,
      resolutionSeconds: query.historyResolutionSeconds,
    });

    return historyPayloadResponse(history, config, query);
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

  latestTimestamp() {
    const point = this.latestPoint();
    return Number(point?.t);
  }

  latestPoint() {
    if (!this.filePath || !existsSync(this.filePath)) {
      return null;
    }

    let fd = null;
    try {
      const { size } = statSync(this.filePath);
      if (!size) {
        return null;
      }

      fd = openSync(this.filePath, "r");
      const chunkSize = 64 * 1024;
      const buffer = Buffer.allocUnsafe(chunkSize);
      let position = size;
      let tail = "";

      while (position > 0) {
        const length = Math.min(chunkSize, position);
        position -= length;
        const bytesRead = readSync(fd, buffer, 0, length, position);
        tail = buffer.toString("utf8", 0, bytesRead) + tail;

        const point = latestPointFromText(tail, { includeFirstLine: position === 0 });
        if (point) {
          return point;
        }
        tail = firstPartialLine(tail);
      }
    } finally {
      if (fd !== null) {
        closeSync(fd);
      }
    }

    return null;
  }

  async compactedWindow({ from, to, resolutionSeconds }) {
    if (!this.filePath || !existsSync(this.filePath) || !Number.isFinite(from) || !Number.isFinite(to)) {
      return [];
    }

    const bucketMs = Math.max(1, Number(resolutionSeconds) || 1) * 1000;
    const buckets = new Map();
    const lines = createInterface({
      input: createReadStream(this.filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    try {
      for await (const line of lines) {
        const timestamp = timestampFromLine(line);
        if (!Number.isFinite(timestamp)) {
          continue;
        }
        if (timestamp < from) {
          continue;
        }
        if (timestamp > to) {
          lines.close();
          break;
        }

        const point = parseLine(line);
        if (point) {
          buckets.set(Math.floor(Number(point.t) / bucketMs) * bucketMs, point);
        }
      }
    } finally {
      lines.close();
    }

    return [...buckets.values()].sort((a, b) => Number(a.t) - Number(b.t));
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

function timestampFromLine(line) {
  const match = /"t"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(line);
  if (!match) {
    const point = parseLine(line);
    return Number(point?.t);
  }
  return Number(match[1]);
}

function latestPointFromText(text, { includeFirstLine = true } = {}) {
  let end = text.length;
  while (end > 0) {
    const newlineIndex = text.lastIndexOf("\n", end - 1);
    const start = newlineIndex + 1;
    if (includeFirstLine || start > 0) {
      const point = parseLine(text.slice(start, end));
      if (point) {
        return point;
      }
    }
    if (newlineIndex === -1) {
      break;
    }
    end = newlineIndex;
  }
  return null;
}

function firstPartialLine(text) {
  const newlineIndex = text.indexOf("\n");
  return newlineIndex === -1 ? text : text.slice(0, newlineIndex);
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
