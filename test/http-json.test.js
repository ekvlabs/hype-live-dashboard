import assert from "node:assert/strict";
import test from "node:test";

import { fetchJsonWithCurlFallback } from "../src/http-json.js";

test("fetchJsonWithCurlFallback uses curl when GET fetch fails", async () => {
  const fetchFn = async () => {
    throw new TypeError("fetch failed");
  };
  const commands = [];
  const runCommand = async (command, args) => {
    commands.push({ command, args });
    return "{\"ok\":true}";
  };

  const result = await fetchJsonWithCurlFallback(fetchFn, "https://api.example.test/twap/*", undefined, {
    runCommand,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(commands[0].command, "curl");
  assert.deepEqual(commands[0].args, [
    "-L",
    "--compressed",
    "-sS",
    "https://api.example.test/twap/*",
  ]);
});
