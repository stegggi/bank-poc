#!/usr/bin/env bash
set -euo pipefail

APP_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../bot"
TARGET_ROOT="/opt/uc6-bot"
TARGET_APP="${TARGET_ROOT}/app"

if ! id -u uc6 >/dev/null 2>&1; then
  echo "User 'uc6' does not exist. Create it first: sudo useradd --system --create-home --shell /usr/sbin/nologin uc6"
  exit 1
fi

sudo mkdir -p "${TARGET_APP}"
sudo rsync -a --delete \
  --exclude node_modules \
  --exclude '.env' \
  "${APP_SRC}/" "${TARGET_APP}/"

sudo chown -R uc6:uc6 "${TARGET_ROOT}"

if [[ ! -f "${TARGET_APP}/package-lock.json" ]]; then
  echo "package-lock.json missing in ${TARGET_APP}; generating lockfile as uc6"
  sudo -u uc6 npm install --package-lock-only --prefix "${TARGET_APP}"
fi

sudo -u uc6 npm ci --prefix "${TARGET_APP}"

echo "UC6 bot deployed to ${TARGET_APP}"
echo "Next steps:"
echo "  1) Create ${TARGET_ROOT}/.env"
echo "  2) Create ${TARGET_ROOT}/settings.json"
echo "  3) Install systemd unit scripts/uc6-lp-bot.service"
