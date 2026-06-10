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
