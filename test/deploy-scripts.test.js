import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('deploy update script pulls main safely and restarts the service only after updates', async () => {
  const script = await readFile(new URL('../scripts/deploy-update.sh', import.meta.url), 'utf8');

  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /git fetch origin "\$\{BRANCH\}"/);
  assert.match(script, /git merge --ff-only "origin\/\$\{BRANCH\}"/);
  assert.match(script, /npm ci --omit=dev/);
  assert.match(script, /systemctl restart "\$\{SERVICE_NAME\}"/);
  assert.doesNotMatch(script, /git reset --hard/);
});

test('pages workflow generates config without inline shell substitutions', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');

  assert.match(workflow, /node scripts\/write-pages-config\.mjs/);
  assert.doesNotMatch(workflow, /node -e/);
  assert.doesNotMatch(workflow, /\$\{JSON\.stringify/);
});

test('pages config writer serializes the API and bot URLs', async () => {
  const { buildConfig } = await import('../scripts/write-pages-config.mjs');

  assert.equal(
    buildConfig('https://api.example.test', 'https://t.me/hypedashboard_bot'),
    'window.HYPE_CONFIG = {"apiBaseUrl":"https://api.example.test","botUrl":"https://t.me/hypedashboard_bot"};\n',
  );
});
