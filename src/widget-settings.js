import { readFile } from "node:fs/promises";
import { join } from "node:path";

const downloadsDir = "\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0438";

export function defaultWidgetPaths(home = process.env.HOME ?? "") {
  return [
    join(home, downloadsDir, "widget-twap-watch (1).json"),
    join(home, downloadsDir, "widget-price-chart.json"),
  ];
}

export async function loadWidgetSettings(paths = defaultWidgetPaths()) {
  const widgets = [];

  for (const path of paths) {
    try {
      const text = await readFile(path, "utf8");
      widgets.push(JSON.parse(text));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return normalizeWidgetSettings(widgets);
}

export function normalizeWidgetSettings(widgets) {
  const settings = {
    twapWatch: {
      marketType: "all",
      pressureAssets: ["HYPE"],
      minValue: 0,
      pressureMode: "total",
      maxTwaps: 20,
      showPressure: true,
    },
    priceChart: {
      coins: ["HYPE"],
      timeframe: "1m",
      showVolume: true,
      chartLayout: "single",
      chartZoom: null,
    },
  };

  for (const widget of widgets ?? []) {
    if (widget?.type === "twapWatch") {
      settings.twapWatch = {
        ...settings.twapWatch,
        ...(widget.settings ?? {}),
      };
    }
    if (widget?.type === "priceChart") {
      settings.priceChart = {
        ...settings.priceChart,
        ...(widget.settings ?? {}),
      };
    }
  }

  return settings;
}
