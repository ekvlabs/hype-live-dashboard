import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function fetchJson(fetchFn, url, init) {
  const response = await fetchFn(url, init);
  if (!response.ok) {
    throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchJsonWithCurlFallback(
  fetchFn,
  url,
  init,
  { runCommand = runCurl } = {},
) {
  try {
    return await fetchJson(fetchFn, url, init);
  } catch (error) {
    if (init && init.method && init.method.toUpperCase() !== "GET") {
      throw error;
    }

    const output = await runCommand("curl", ["-L", "--compressed", "-sS", url]);
    return JSON.parse(output);
  }
}

async function runCurl(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}
