import assert from "node:assert/strict";
import test from "node:test";

import { apiCorsHeaders } from "../src/cors.js";

test("apiCorsHeaders allows GitHub Pages to read live API endpoints", () => {
  assert.deepEqual(apiCorsHeaders(), {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
});
