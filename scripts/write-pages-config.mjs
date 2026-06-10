import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function buildConfig(apiBaseUrl = '', botUrl = '') {
  return `window.HYPE_CONFIG = ${JSON.stringify({ apiBaseUrl, botUrl })};\n`;
}

export async function writeConfig({
  env = process.env,
  outputPath = 'public/config.js',
} = {}) {
  await writeFile(
    outputPath,
    buildConfig(env.HYPE_API_BASE_URL ?? '', env.TELEGRAM_BOT_URL ?? ''),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeConfig();
}
