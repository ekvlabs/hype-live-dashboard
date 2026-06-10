import assert from "node:assert/strict";
import test from "node:test";

import { AnalyticsStore, classifyRequestPath } from "../src/analytics-store.js";

test("classifyRequestPath separates page views, API calls, assets, and analytics", () => {
  assert.equal(classifyRequestPath("/"), "page");
  assert.equal(classifyRequestPath("/index.html"), "page");
  assert.equal(classifyRequestPath("/api/state"), "api");
  assert.equal(classifyRequestPath("/api/analytics"), "analytics");
  assert.equal(classifyRequestPath("/app.js"), "asset");
});

test("AnalyticsStore records requests and returns aggregate visitor stats", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 10 * day;
  const store = new AnalyticsStore(":memory:");

  store.recordRequest({
    at: now - 1_000,
    method: "GET",
    path: "/",
    statusCode: 200,
    durationMs: 12,
    ip: "1.1.1.1",
    userAgent: "browser-a",
  });
  store.recordRequest({
    at: now - 500,
    method: "GET",
    path: "/index.html",
    statusCode: 200,
    durationMs: 8,
    ip: "1.1.1.1",
    userAgent: "browser-a",
  });
  store.recordRequest({
    at: now - 400,
    method: "GET",
    path: "/api/state",
    statusCode: 200,
    durationMs: 18,
    ip: "2.2.2.2",
    userAgent: "browser-b",
  });
  store.recordRequest({
    at: now - 8 * day,
    method: "GET",
    path: "/",
    statusCode: 200,
    durationMs: 10,
    ip: "3.3.3.3",
    userAgent: "old-browser",
  });

  const summary = store.summary({ now });

  assert.equal(summary.windows.day.site.pageViews, 2);
  assert.equal(summary.windows.day.site.uniqueVisitors, 1);
  assert.equal(summary.windows.day.api.requests, 1);
  assert.equal(summary.windows.week.site.pageViews, 2);
  assert.equal(summary.windows.all.site.pageViews, 3);
  assert.equal(summary.windows.all.site.uniqueVisitors, 2);
});
