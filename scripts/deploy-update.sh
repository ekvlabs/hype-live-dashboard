#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/hype-live-dashboard}"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-hype-live-dashboard.service}"

cd "${APP_DIR}"

before_head="$(git rev-parse HEAD)"
before_lock="$(git rev-parse HEAD:package-lock.json 2>/dev/null || true)"

git fetch origin "${BRANCH}"

remote_head="$(git rev-parse "origin/${BRANCH}")"
if [[ "${before_head}" == "${remote_head}" ]]; then
  echo "Already up to date: ${before_head}"
  exit 0
fi

git merge --ff-only "origin/${BRANCH}"

after_head="$(git rev-parse HEAD)"
after_lock="$(git rev-parse HEAD:package-lock.json 2>/dev/null || true)"

if [[ ! -d node_modules || "${before_lock}" != "${after_lock}" ]]; then
  npm ci --omit=dev
fi

systemctl restart "${SERVICE_NAME}"
echo "Updated ${APP_DIR} from ${before_head} to ${after_head}"
