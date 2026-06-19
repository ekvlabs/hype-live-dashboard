import {
  RESOLUTIONS,
  driverEventsToCompactMarkers,
  historyToAlignedLineData,
  historyToAlignedPriceBars,
  minimumBarSpacingForRange,
  needsVerticalAutoscale,
  nextLiveVisibleRange,
  normalizedHistory,
  pruneSeriesData,
  requiredHistoryHoursForDriverEvents,
  selectedHistoryWindow,
  shouldKeepLiveFollowing,
  snapMarkersToSeriesData,
  upsertAlignedLineDataPoint,
  upsertAlignedPriceBarData,
  visibleTimeRangeForDriverEvents,
} from "./chart-data.js?v=26";

const POLL_INTERVAL_MS = 1_000;
const LIVE_FETCH_TIMEOUT_MS = 3_000;
const DEFAULT_RANGE_HOURS = 1;
const CHART_HEIGHT = 280;
const COMPACT_CHART_HEIGHT = 220;
const API_BASE_URL = normalizeApiBaseUrl(window.HYPE_CONFIG?.apiBaseUrl ?? window.HYPE_API_BASE_URL ?? "");

const {
  BarSeries,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
} = window.LightweightCharts;

const elements = {
  alertBotLink: document.querySelector("#alertBotLink"),
  status: document.querySelector("#status"),
  statusText: document.querySelector("#statusText"),
  twap1h: document.querySelector("#twap1h"),
  twap24h: document.querySelector("#twap24h"),
  hypePrice: document.querySelector("#hypePrice"),
  priceSource: document.querySelector("#priceSource"),
  activeTwaps: document.querySelector("#activeTwaps"),
  marketCount: document.querySelector("#marketCount"),
  updatedAt: document.querySelector("#updatedAt"),
  marketList: document.querySelector("#marketList"),
  rangeInfo: document.querySelector("#rangeInfo"),
  showDriverMarkers: document.querySelector("#showDriverMarkers"),
  rangeButtons: [...document.querySelectorAll(".range-btn")],
  resolutionButtons: [...document.querySelectorAll("[data-resolution]")],
  chartTwap1hValue: document.querySelector("#chartTwap1hValue"),
  chartTwap24hValue: document.querySelector("#chartTwap24hValue"),
  chartPriceValue: document.querySelector("#chartPriceValue"),
  chartFundingValue: document.querySelector("#chartFundingValue"),
  chartOpenInterestValue: document.querySelector("#chartOpenInterestValue"),
  chartPremiumValue: document.querySelector("#chartPremiumValue"),
  chartMarkOracleValue: document.querySelector("#chartMarkOracleValue"),
  priceChartTitle: document.querySelector("#priceChartTitle"),
  twap1hChart: document.querySelector("#twap1hChart"),
  twap24hChart: document.querySelector("#twap24hChart"),
  priceChart: document.querySelector("#priceChart"),
  fundingChart: document.querySelector("#fundingChart"),
  openInterestChart: document.querySelector("#openInterestChart"),
  premiumChart: document.querySelector("#premiumChart"),
  markOracleChart: document.querySelector("#markOracleChart"),
};

const chartEntries = [
  {
    id: "twap1h",
    container: elements.twap1hChart,
    key: "next1h",
    color: "#10b437",
    type: "line",
    formatter: formatAxisMoney,
    zeroLine: true,
  },
  {
    id: "twap24h",
    container: elements.twap24hChart,
    key: "next24h",
    color: "#45d3c3",
    type: "line",
    formatter: formatAxisMoney,
    zeroLine: true,
  },
  {
    id: "price",
    container: elements.priceChart,
    type: "bar",
    formatter: formatAxisPrice,
  },
  {
    id: "funding",
    container: elements.fundingChart,
    key: "funding",
    color: "#9ad95f",
    type: "line",
    formatter: formatAxisPercent,
    height: COMPACT_CHART_HEIGHT,
    zeroLine: true,
  },
  {
    id: "openInterest",
    container: elements.openInterestChart,
    key: "openInterest",
    color: "#7aa8ff",
    type: "line",
    formatter: formatAxisCompact,
    height: COMPACT_CHART_HEIGHT,
  },
  {
    id: "premium",
    container: elements.premiumChart,
    key: "premium",
    color: "#d982ff",
    type: "line",
    formatter: formatAxisBps,
    height: COMPACT_CHART_HEIGHT,
    zeroLine: true,
  },
  {
    id: "markOracle",
    container: elements.markOracleChart,
    key: "markPx",
    color: "#f3bc45",
    type: "line",
    formatter: formatAxisPrice,
    height: COMPACT_CHART_HEIGHT,
    extraLines: [{ key: "oraclePx", color: "#45d3c3" }],
  },
].map(createChartEntry);

let selectedHours = DEFAULT_RANGE_HOURS;
let selectedResolution = RESOLUTIONS[0];
let lastState = null;
let pollTimer = null;
let liveFetchInFlight = false;
let historyRequestId = 0;
let hasAppliedInitialRange = false;
let isLiveFollowing = true;
let isSyncingRange = false;
let isSyncingCrosshair = false;
let ignoreRangeEventsUntil = 0;
let showDriverMarkers = Boolean(elements.showDriverMarkers?.checked);
let focusDriverMarkersOnNextRender = showDriverMarkers;

configureAlertBotLink();
recordVisit();
wireRangeControls();
wireResolutionControls();
wireDriverMarkerToggle();
wireResize();
wireChartSync();
applyTimeScaleDensity();
connectEvents();
fetchSnapshot();

function createChartEntry(definition) {
  const chart = createChart(definition.container, chartOptions(definition.container, definition.height ?? CHART_HEIGHT));
  let series;
  if (definition.type === "bar") {
    series = chart.addSeries(BarSeries, {
      upColor: "#10b437",
      downColor: "#e34b4b",
      thinBars: true,
      priceFormat: {
        type: "custom",
        formatter: definition.formatter,
      },
    });
  } else {
    series = chart.addSeries(LineSeries, {
      color: definition.color,
      lineWidth: 2,
      pointMarkersVisible: true,
      pointMarkersRadius: 2,
      crosshairMarkerVisible: true,
      priceFormat: {
        type: "custom",
        formatter: definition.formatter,
      },
    });
  }
  const markers = typeof createSeriesMarkers === "function" ? createSeriesMarkers(series, [], { zOrder: "aboveSeries" }) : null;
  const extraSeries = (definition.extraLines ?? []).map((line) => ({
    ...line,
    series: chart.addSeries(LineSeries, {
      color: line.color,
      lineWidth: 2,
      pointMarkersVisible: true,
      pointMarkersRadius: 2,
      crosshairMarkerVisible: true,
      priceFormat: {
        type: "custom",
        formatter: definition.formatter,
      },
    }),
    data: [],
    dataByTime: new Map(),
  }));

  if (definition.zeroLine) {
    series.createPriceLine({
      price: 0,
      color: "rgba(255,255,255,0.42)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: "0",
    });
  }
  return {
    ...definition,
    chart,
    series,
    markers,
    data: [],
    dataByTime: new Map(),
    extraSeries,
  };
}

function chartOptions(container, height = CHART_HEIGHT) {
  return {
    width: container.clientWidth,
    height,
    autoSize: true,
    layout: {
      background: { type: "solid", color: "transparent" },
      textColor: "#93a5a0",
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: 12,
    },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.04)" },
      horzLines: { color: "rgba(255,255,255,0.08)" },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: "rgba(243,247,245,0.34)", width: 1, style: LineStyle.Dashed },
      horzLine: { color: "rgba(243,247,245,0.24)", width: 1, style: LineStyle.Dashed },
    },
    leftPriceScale: { visible: false },
    rightPriceScale: {
      autoScale: true,
      visible: true,
      borderVisible: false,
      scaleMargins: { top: 0.12, bottom: 0.12 },
    },
    timeScale: {
      timeVisible: true,
      secondsVisible: true,
      borderVisible: false,
      rightOffset: 4,
      barSpacing: 8,
      minBarSpacing: 0.02,
      rightBarStaysOnScroll: false,
      shiftVisibleRangeOnNewBar: false,
    },
    localization: {
      locale: "ru-RU",
      timeFormatter: (timestamp) => formatTime(Number(timestamp) * 1000),
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true,
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
    },
  };
}

function wireRangeControls() {
  for (const button of elements.rangeButtons.filter((item) => item.dataset.range)) {
    button.addEventListener("click", () => {
      setSelectedHistoryRange(Number(button.dataset.range) || DEFAULT_RANGE_HOURS);
      isLiveFollowing = true;
      focusDriverMarkersOnNextRender = showDriverMarkers;
      loadHistory({ forceRange: true });
    });
  }
}

function wireResolutionControls() {
  for (const button of elements.resolutionButtons) {
    button.addEventListener("click", () => {
      selectedResolution =
        RESOLUTIONS.find((resolution) => resolution.id === button.dataset.resolution) ?? RESOLUTIONS[0];
      for (const item of elements.resolutionButtons) {
        item.classList.toggle("active", item === button);
      }
      isLiveFollowing = true;
      focusDriverMarkersOnNextRender = showDriverMarkers;
      applyTimeScaleDensity();
      loadHistory({ forceRange: true });
    });
  }
}

function wireDriverMarkerToggle() {
  elements.showDriverMarkers?.addEventListener("change", () => {
    showDriverMarkers = Boolean(elements.showDriverMarkers.checked);
    focusDriverMarkersOnNextRender = showDriverMarkers;
    if (showDriverMarkers && expandHistoryRangeForDriverMarkers(lastState?.driverEvents ?? [])) {
      return;
    }
    setDriverMarkers(lastState?.driverEvents ?? []);
    if (showDriverMarkers) {
      focusDriverMarkersOnNextRender = false;
      applyDriverMarkerVisibleWindow(lastState?.driverEvents ?? []);
    }
  });
}

function setSelectedHistoryRange(hours) {
  selectedHours = Number(hours) || DEFAULT_RANGE_HOURS;
  for (const item of elements.rangeButtons.filter((item) => item.dataset.range)) {
    item.classList.toggle("active", Number(item.dataset.range) === selectedHours);
  }
  applyTimeScaleDensity();
}

function expandHistoryRangeForDriverMarkers(events) {
  const anchorTime = latestLoadedHistoryTime();
  const requiredHours = requiredHistoryHoursForDriverEvents(events, anchorTime);
  if (!Number.isFinite(requiredHours) || requiredHours <= selectedHours) {
    return false;
  }

  const ranges = availableHistoryRanges();
  const nextRange = ranges.find((range) => range >= requiredHours) ?? ranges.at(-1);
  if (!Number.isFinite(nextRange) || nextRange <= selectedHours) {
    return false;
  }

  setSelectedHistoryRange(nextRange);
  isLiveFollowing = true;
  loadHistory({ forceRange: true });
  return true;
}

function applyDriverMarkerVisibleWindow(events) {
  const range = visibleTimeRangeForDriverEvents(events);
  if (!range) {
    return false;
  }

  withProgrammaticRangeUpdate(() => {
    for (const entry of chartEntries) {
      entry.chart.timeScale().setVisibleRange(range);
    }
  });
  isLiveFollowing = false;
  autoScaleAllVertical();
  return true;
}

function latestLoadedHistoryTime() {
  const history = normalizedHistory(lastState?.history ?? []);
  return history.at(-1)?.time ?? Math.floor(Number(lastState?.snapshot?.timestamp ?? Date.now()) / 1000);
}

function availableHistoryRanges() {
  return elements.rangeButtons
    .filter((item) => item.dataset.range)
    .map((item) => Number(item.dataset.range))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function wireResize() {
  const resizeObserver = new ResizeObserver(() => {
    for (const entry of chartEntries) {
      entry.chart.applyOptions({
        width: entry.container.clientWidth,
        height: entry.height ?? CHART_HEIGHT,
      });
    }
    applyTimeScaleDensity();
  });

  for (const entry of chartEntries) {
    resizeObserver.observe(entry.container);
  }
}

function applyTimeScaleDensity() {
  for (const entry of chartEntries) {
    entry.chart.timeScale().applyOptions({
      minBarSpacing: minimumBarSpacingForRange(
        entry.container.clientWidth,
        selectedHours,
        selectedResolution.seconds,
      ),
    });
  }
}

function wireChartSync() {
  for (const entry of chartEntries) {
    entry.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      syncVisibleLogicalRange(entry, range);
    });

    entry.chart.subscribeCrosshairMove((param) => {
      syncCrosshair(entry, param);
    });
  }
}

function syncVisibleLogicalRange(sourceEntry, range) {
  if (!range || isSyncingRange) {
    return;
  }

  if (hasAppliedInitialRange && !isProgrammaticRangeEvent()) {
    isLiveFollowing = false;
  }

  isSyncingRange = true;
  for (const entry of chartEntries) {
    if (entry !== sourceEntry) {
      entry.chart.timeScale().setVisibleLogicalRange(range);
    }
  }
  isSyncingRange = false;
  autoScaleAllVertical();
}

function syncCrosshair(sourceEntry, param) {
  if (isSyncingCrosshair) {
    return;
  }

  isSyncingCrosshair = true;
  if (!param.time) {
    for (const entry of chartEntries) {
      if (entry !== sourceEntry) {
        entry.chart.clearCrosshairPosition();
      }
    }
    isSyncingCrosshair = false;
    return;
  }

  for (const entry of chartEntries) {
    if (entry === sourceEntry) {
      continue;
    }
    const dataPoint = entry.dataByTime.get(Number(param.time));
    const value = chartValue(dataPoint);
    if (Number.isFinite(value)) {
      entry.chart.setCrosshairPosition(value, param.time, entry.series);
    } else {
      entry.chart.clearCrosshairPosition();
    }
  }
  isSyncingCrosshair = false;
}

function connectEvents() {
  startPolling();
}

async function fetchSnapshot() {
  try {
    const [state, historyState, signalPayload] = await Promise.all([
      fetch(apiPath("/api/state"), { cache: "no-store" }).then((response) => response.json()),
      fetchHistory(),
      fetchDriverSignalEvents().catch(() => null),
    ]);
    render({
      ...state,
      history: historyState?.history ?? [],
      config: {
        ...(state.config ?? {}),
        ...(historyState?.config ?? {}),
      },
      driverEvents: signalPayload?.items ?? [],
    }, { forceRange: true });
  } catch (error) {
    setStatus({ ok: false, message: error.message });
    startPolling();
  }
}

async function loadHistory(options = {}) {
  const requestId = ++historyRequestId;
  try {
    const historyState = await fetchHistory();
    if (requestId !== historyRequestId) {
      return false;
    }
    render({
      ...lastState,
      history: historyState?.history ?? [],
      config: {
        ...(lastState?.config ?? {}),
        ...(historyState?.config ?? {}),
      },
    }, {
      forceRange: Boolean(options.forceRange),
    });
    return true;
  } catch (error) {
    if (requestId === historyRequestId) {
      setStatus({ ok: false, message: error.message });
    }
    return false;
  }
}

async function fetchLiveState() {
  if (liveFetchInFlight) {
    return;
  }

  liveFetchInFlight = true;
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, LIVE_FETCH_TIMEOUT_MS);

  try {
    const [state, signalPayload] = await Promise.all([
      fetch(apiPath("/api/state"), {
        cache: "no-store",
        signal: abortController.signal,
      }).then((response) => {
        if (!response.ok) {
          throw new Error(`state ${response.status}`);
        }
        return response.json();
      }),
      fetchDriverSignalEvents().catch(() => null),
    ]);
    state.driverEvents = signalPayload?.items ?? lastState?.driverEvents ?? [];
    const point = historyPointFromSnapshot(state.snapshot);
    if (point) {
      appendHistoryPoint(point, state);
    } else {
      mergeState(state);
    }
  } catch (error) {
    setStatus({ ok: false, message: error.name === "AbortError" ? "state timeout" : error.message });
  } finally {
    clearTimeout(timeout);
    liveFetchInFlight = false;
  }
}

async function fetchDriverSignalEvents() {
  const response = await fetch(apiPath("/api/twap-driver/signals") + "?limit=2000", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`signals ${response.status}`);
  }
  return response.json();
}

async function fetchHistory() {
  const response = await fetch(apiPath("/api/history") + historyQueryString(), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`history ${response.status}`);
  }
  return response.json();
}

function historyQueryString() {
  const params = new URLSearchParams({
    hours: String(selectedHours),
    resolution: String(selectedResolution.seconds),
  });
  return `?${params.toString()}`;
}

function apiPath(path) {
  return `${API_BASE_URL}${path}`;
}

function normalizeApiBaseUrl(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function configureAlertBotLink() {
  const botUrl = normalizeExternalUrl(window.HYPE_CONFIG?.botUrl ?? "");
  if (!botUrl) {
    elements.alertBotLink.hidden = true;
    elements.alertBotLink.removeAttribute("href");
    return;
  }

  elements.alertBotLink.href = botUrl;
  elements.alertBotLink.hidden = false;
}

function recordVisit() {
  fetch(apiPath("/api/visit"), {
    cache: "no-store",
    keepalive: true,
  }).catch(() => {});
}

function normalizeExternalUrl(value) {
  const url = String(value ?? "").trim();
  if (!/^https:\/\/t\.me\/[a-zA-Z0-9_]+$/.test(url)) {
    return "";
  }
  return url;
}

function startPolling() {
  if (pollTimer) {
    return;
  }
  pollTimer = setInterval(fetchLiveState, POLL_INTERVAL_MS);
  fetchLiveState();
}

function render(state, options = {}) {
  if (!state) {
    return;
  }

  lastState = {
    ...lastState,
    ...state,
    history: state.history ?? lastState?.history ?? [],
    config: state.config ?? lastState?.config ?? {},
    driverEvents: state.driverEvents ?? lastState?.driverEvents ?? [],
  };
  const snapshot = lastState.snapshot;
  setStatus(lastState.status);
  const history = normalizedHistory(lastState.history ?? []);
  const config = lastState.config ?? {};

  if (!snapshot) {
    setChartData(history);
    return;
  }

  setText(elements.twap1h, formatMoney(snapshot.pressure.next1h, true));
  setText(elements.twap24h, formatMoney(snapshot.pressure.next24h, true));
  setText(elements.hypePrice, formatPrice(snapshot.price));
  setText(elements.priceSource, snapshot.priceSource);
  setText(elements.activeTwaps, snapshot.activeHypeTwaps);
  setText(elements.marketCount, snapshot.hypeMarkets.length);
  setText(elements.chartTwap1hValue, formatMoney(snapshot.pressure.next1h, true));
  setText(elements.chartTwap24hValue, formatMoney(snapshot.pressure.next24h, true));
  setText(elements.chartPriceValue, formatPrice(snapshot.price));
  setText(elements.chartFundingValue, formatPercent(snapshot.perp?.funding));
  setText(elements.chartOpenInterestValue, formatCompact(snapshot.perp?.openInterest));
  setText(elements.chartPremiumValue, formatBps(snapshot.perp?.premium));
  setText(elements.chartMarkOracleValue, formatMarkOracle(snapshot.perp));
  setText(elements.priceChartTitle, `HYPE ${selectedResolution.label} price`);
  setText(elements.updatedAt, `Last update: ${formatTime(snapshot.timestamp)}`);
  setText(elements.marketList, `Markets: ${snapshot.hypeMarkets.map((market) => market.coin).join(", ")}`);
  setText(
    elements.rangeInfo,
    `Range: ${formatRangeHours(selectedHours)} | Step: ${selectedResolution.label} | Loaded: ${formatHistoryResolution(config.historyResolutionSeconds)} | Stored: ${formatStoredRange(lastState.history)} | Poll: ${formatSeconds(config.intervalMs)} | Price: live`,
  );

  setSignedClass(elements.twap1h, snapshot.pressure.next1h);
  setSignedClass(elements.twap24h, snapshot.pressure.next24h);
  setSignedClass(elements.chartTwap1hValue, snapshot.pressure.next1h);
  setSignedClass(elements.chartTwap24hValue, snapshot.pressure.next24h);

  if (options.incrementalPoint && hasAppliedInitialRange && !options.forceRange) {
    appendChartData(options.incrementalPoint);
  } else {
    setChartData(history);
  }

  if (showDriverMarkers && applyDriverMarkerVisibleWindow(lastState.driverEvents ?? [])) {
    focusDriverMarkersOnNextRender = false;
    hasAppliedInitialRange = true;
  } else if (options.forceRange || !hasAppliedInitialRange) {
    applyVisibleTimeWindow(history);
    hasAppliedInitialRange = true;
  } else if (options.followLive) {
    applyLiveVisibleWindow(history, options.visibleRange);
  }
}

function mergeState(update) {
  render({
    ...lastState,
    ...update,
    history: lastState?.history ?? [],
  });
}

function appendHistoryPoint(point, statePatch = {}) {
  if (!point) {
    return;
  }

  const previous = lastState ?? { history: [], config: {} };
  const previousHistory = normalizedHistory(previous.history ?? []);
  const previousLastTime = previousHistory.at(-1)?.time;
  const visibleRange = chartEntries[0]?.chart.timeScale().getVisibleRange() ?? null;
  const followLive = shouldKeepLiveFollowing(isLiveFollowing, visibleRange, previousLastTime);
  const config = previous.config ?? {};
  const maxHistoryHours = Number(config.maxHistoryHours) || 336;
  const historyLimit = Number(config.historyLimit) || 1_209_600;
  const cutoff = Number(point.t) - maxHistoryHours * 60 * 60 * 1000;
  const history = [...(previous.history ?? []), point]
    .filter((item) => Number(item.t) >= cutoff)
    .slice(-historyLimit);
  const incrementalPoint = normalizedHistory([point]).at(-1) ?? null;

  render({
    ...previous,
    ...statePatch,
    history,
  }, {
    followLive,
    visibleRange,
    incrementalPoint,
  });
}

function historyPointFromSnapshot(snapshot) {
  if (!snapshot?.pressure) {
    return null;
  }

  const point = {
    t: Date.now(),
    price: snapshot.price,
    next1h: snapshot.pressure.next1h,
    next24h: snapshot.pressure.next24h,
  };
  for (const key of ["funding", "openInterest", "premium", "markPx", "oraclePx"]) {
    const value = Number(snapshot.perp?.[key]);
    if (Number.isFinite(value)) {
      point[key] = value;
    }
  }
  return point;
}

function setChartData(history) {
  const chartHistory = selectedHistoryWindow(history, selectedHours);
  for (const entry of chartEntries) {
    const data = chartDataForEntry(entry, chartHistory);
    entry.data = data;
    entry.dataByTime = new Map(data.map((point) => [point.time, point]));
    entry.series.setData(data);
    for (const extra of entry.extraSeries ?? []) {
      const extraData = historyToAlignedLineData(chartHistory, extra.key, selectedResolution.seconds, extra.color);
      extra.data = extraData;
      extra.dataByTime = new Map(extraData.map((point) => [point.time, point]));
      extra.series.setData(extraData);
    }
    autoScaleVertical(entry);
  }
  setDriverMarkers(lastState?.driverEvents ?? []);
}

function appendChartData(point) {
  const chartPoint = point;
  const oldestTime = Number(point.time) - selectedHours * 60 * 60;
  const bucketTime = Math.floor(Number(chartPoint.time) / selectedResolution.seconds) * selectedResolution.seconds;

  for (const entry of chartEntries) {
    const nextData = upsertChartDataForEntry(entry, chartPoint);
    const prunedData = pruneSeriesData(nextData, oldestTime);
    const updatedPoint = nextData.find((item) => Number(item.time) === bucketTime);
    entry.data = prunedData;
    entry.dataByTime = new Map(prunedData.map((item) => [item.time, item]));
    if (prunedData.length < nextData.length || !updatedPoint) {
      entry.series.setData(prunedData);
    } else {
      entry.series.update(updatedPoint);
    }
    for (const extra of entry.extraSeries ?? []) {
      const nextExtraData = upsertAlignedLineDataPoint(
        extra.data,
        chartPoint,
        extra.key,
        selectedResolution.seconds,
        extra.color,
      );
      const prunedExtraData = pruneSeriesData(nextExtraData, oldestTime);
      const updatedExtraPoint = nextExtraData.find((item) => Number(item.time) === bucketTime);
      extra.data = prunedExtraData;
      extra.dataByTime = new Map(prunedExtraData.map((item) => [item.time, item]));
      if (prunedExtraData.length < nextExtraData.length || !updatedExtraPoint) {
        extra.series.setData(prunedExtraData);
      } else {
        extra.series.update(updatedExtraPoint);
      }
    }
    autoScaleVertical(entry);
  }
  setDriverMarkers(lastState?.driverEvents ?? []);
}

function chartDataForEntry(entry, history) {
  if (entry.type === "bar") {
    return historyToAlignedPriceBars(history, selectedResolution.seconds);
  }
  return historyToAlignedLineData(history, entry.key, selectedResolution.seconds, entry.color);
}

function upsertChartDataForEntry(entry, point) {
  if (entry.type === "bar") {
    return upsertAlignedPriceBarData(entry.data, point, selectedResolution.seconds);
  }
  return upsertAlignedLineDataPoint(entry.data, point, entry.key, selectedResolution.seconds, entry.color);
}

function setDriverMarkers(events) {
  const markers = showDriverMarkers
    ? driverEventsToCompactMarkers(events).map((marker) => ({
        ...marker,
        time: alignTimeToResolution(marker.time),
      }))
    : [];
  const priceEntry = chartEntries.find((entry) => entry.id === "price");
  const priceMarkers = snapMarkersToSeriesData(markers, priceEntry?.data ?? [], markerSnapToleranceSeconds());
  for (const entry of chartEntries) {
    const entryMarkers = entry.id === "price" ? priceMarkers : [];
    if (entry.markers?.setMarkers) {
      entry.markers.setMarkers(entryMarkers);
    } else if (typeof entry.series.setMarkers === "function") {
      entry.series.setMarkers(entryMarkers);
    }
  }
}

function markerSnapToleranceSeconds() {
  return Math.max(60, selectedResolution.seconds * 3);
}

function alignTimeToResolution(time) {
  const number = Number(time);
  const seconds = Math.max(1, Number(selectedResolution.seconds) || 1);
  return Number.isFinite(number) ? Math.floor(number / seconds) * seconds : number;
}

function applyVisibleTimeWindow(history) {
  const lastTime = history.at(-1)?.time;
  if (!lastTime) {
    return;
  }

  const firstTime = history[0]?.time ?? lastTime;
  const from = Math.max(firstTime, lastTime - selectedHours * 60 * 60);
  withProgrammaticRangeUpdate(() => {
    for (const entry of chartEntries) {
      entry.chart.timeScale().setVisibleRange({ from, to: lastTime });
    }
  });
  autoScaleAllVertical();
}

function applyLiveVisibleWindow(history, previousVisibleRange) {
  const lastTime = history.at(-1)?.time;
  const range = nextLiveVisibleRange(previousVisibleRange, selectedHours, lastTime);
  if (!range) {
    return;
  }

  withProgrammaticRangeUpdate(() => {
    for (const entry of chartEntries) {
      entry.chart.timeScale().setVisibleRange(range);
    }
  });
  autoScaleAllVertical();
}

function withProgrammaticRangeUpdate(callback) {
  ignoreRangeEventsUntil = Date.now() + 250;
  callback();
}

function isProgrammaticRangeEvent() {
  return Date.now() <= ignoreRangeEventsUntil;
}

function autoScaleAllVertical() {
  for (const entry of chartEntries) {
    autoScaleVertical(entry);
  }
}

function autoScaleVertical(entry) {
  const data = [entry.data, ...(entry.extraSeries ?? []).map((extra) => extra.data)].flat();
  if (!data.length) {
    return;
  }

  const priceScale = entry.series.priceScale();
  const priceRange = priceScale.getVisibleRange();
  const timeRange = entry.chart.timeScale().getVisibleRange();
  if (needsVerticalAutoscale(data, priceRange, timeRange)) {
    priceScale.setAutoScale(true);
  }
}

function chartValue(dataPoint) {
  if (!dataPoint) {
    return null;
  }
  if ("value" in dataPoint) {
    return Number(dataPoint.value);
  }
  return Number(dataPoint.close);
}

function setStatus(status) {
  elements.status.classList.toggle("live", Boolean(status?.ok));
  elements.status.classList.toggle("error", Boolean(status && !status.ok));
  setText(elements.statusText, status?.message ?? "starting");
}

function setSignedClass(element, value) {
  element.classList.toggle("negative", Number(value) < 0);
  element.classList.toggle("positive", Number(value) >= 0);
}

function setText(element, value) {
  element.textContent = value;
}

function formatMoney(value, signed = false) {
  if (!Number.isFinite(Number(value))) {
    return "--";
  }
  const prefix = signed && value >= 0 ? "+" : "";
  return `${prefix}${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value)}$`;
}

function formatAxisMoney(value) {
  if (!Number.isFinite(Number(value))) {
    return "";
  }
  const prefix = value >= 0 ? "+" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${prefix}${(value / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    return `${prefix}${(value / 1_000).toFixed(0)}K`;
  }
  return `${prefix}${value.toFixed(0)}`;
}

function formatPrice(value) {
  if (!Number.isFinite(Number(value))) {
    return "--";
  }
  return `$${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value)}`;
}

function formatAxisPrice(value) {
  if (!Number.isFinite(Number(value))) {
    return "";
  }
  return `$${Number(value).toFixed(3)}`;
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) {
    return "--";
  }
  return `${(Number(value) * 100).toFixed(4)}%`;
}

function formatAxisPercent(value) {
  if (!Number.isFinite(Number(value))) {
    return "";
  }
  return `${(Number(value) * 100).toFixed(4)}%`;
}

function formatBps(value) {
  if (!Number.isFinite(Number(value))) {
    return "--";
  }
  return `${(Number(value) * 10_000).toFixed(2)} bp`;
}

function formatAxisBps(value) {
  if (!Number.isFinite(Number(value))) {
    return "";
  }
  return `${(Number(value) * 10_000).toFixed(1)}bp`;
}

function formatCompact(value) {
  if (!Number.isFinite(Number(value))) {
    return "--";
  }
  return formatAxisCompact(value);
}

function formatAxisCompact(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "";
  }
  const abs = Math.abs(number);
  if (abs >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 1_000) {
    return `${(number / 1_000).toFixed(1)}K`;
  }
  return number.toFixed(2);
}

function formatMarkOracle(perp) {
  if (!perp) {
    return "--";
  }
  return `${formatPrice(perp.markPx)} / ${formatPrice(perp.oraclePx)}`;
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "--";
  }
  return new Date(timestamp).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatSeconds(intervalMs) {
  if (!Number.isFinite(Number(intervalMs))) {
    return "--";
  }
  return `${Number(intervalMs) / 1000}s`;
}

function formatStoredRange(history) {
  if (!history?.length) {
    return "0h";
  }
  const spanMs = history.at(-1).t - history[0].t;
  const hours = spanMs / (60 * 60 * 1000);
  return formatRangeHours(hours);
}

function formatHistoryResolution(seconds) {
  const number = Number(seconds);
  if (!Number.isFinite(number) || number <= 0) {
    return "--";
  }
  if (number < 60) {
    return `${number}s`;
  }
  return `${number / 60}m`;
}

function formatRangeHours(hours) {
  const number = Number(hours);
  if (!Number.isFinite(number) || number <= 0) {
    return "0h";
  }

  if (number < 1) {
    return `${Math.round(number * 60)}m`;
  }
  if (number >= 48) {
    return `${(number / 24).toFixed(number % 24 === 0 ? 0 : 1)}d`;
  }
  return `${number.toFixed(number % 1 === 0 ? 0 : 1)}h`;
}
