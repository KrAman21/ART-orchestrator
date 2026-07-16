#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCK_FILE="${ART_FINAL_STORE_LOCK_FILE:-/tmp/art-final-store-cron.lock}"
CRON_LOG_FILE="${ART_FINAL_STORE_CRON_LOG_FILE:-${REPO_ROOT}/logs/art-final-store-cron.log}"

mkdir -p "$(dirname "${CRON_LOG_FILE}")"

exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "$(date -Is) another art-final-store cron run is active" >> "${CRON_LOG_FILE}"
  exit 0
fi

cd "${REPO_ROOT}"

export ART_FINAL_STORE_LOOKBACK_MINUTES="${ART_FINAL_STORE_LOOKBACK_MINUTES:-10}"
export ART_FINAL_STORE_LOG_DELAY_MINUTES="${ART_FINAL_STORE_LOG_DELAY_MINUTES:-5}"
export ART_FINAL_STORE_ORDER_LIMIT="${ART_FINAL_STORE_ORDER_LIMIT:-20}"
export ART_FINAL_STORE_WORKERS="${ART_FINAL_STORE_WORKERS:-4}"
export ART_FINAL_STORE_DIR="${ART_FINAL_STORE_DIR:-/home/kumar-aman/art-final-store}"

export ART_FILTERED_STORE_LOOKBACK_MINUTES="${ART_FILTERED_STORE_LOOKBACK_MINUTES:-60}"
export ART_FILTERED_STORE_LOG_DELAY_MINUTES="${ART_FILTERED_STORE_LOG_DELAY_MINUTES:-5}"
export ART_FILTERED_STORE_WORKERS="${ART_FILTERED_STORE_WORKERS:-4}"
export ART_FILTERED_STORE_DIR="${ART_FILTERED_STORE_DIR:-/home/kumar-aman/logsStore}"
export ART_FILTERED_STORE_TOTAL_ORDER_LIMIT="${ART_FILTERED_STORE_TOTAL_ORDER_LIMIT:-100}"
export ART_FILTERED_STORE_BATCH_SIZE="${ART_FILTERED_STORE_BATCH_SIZE:-50}"
export ART_FILTERED_STORE_WINDOW_MINUTES="${ART_FILTERED_STORE_WINDOW_MINUTES:-30}"
export ART_FILTERED_STORE_PROGRESS_EVERY="${ART_FILTERED_STORE_PROGRESS_EVERY:-25}"
export ART_FILTERED_STORE_SOURCE_DELAY_MS="${ART_FILTERED_STORE_SOURCE_DELAY_MS:-500}"
export ART_FILTERED_STORE_MAX_RETRIES="${ART_FILTERED_STORE_MAX_RETRIES:-3}"
export ART_FILTERED_STORE_RETRY_DELAY_MS="${ART_FILTERED_STORE_RETRY_DELAY_MS:-2000}"
export ART_FILTERED_STORE_FETCH_ATTEMPTS="${ART_FILTERED_STORE_FETCH_ATTEMPTS:-5}"
export ART_FILTERED_STORE_FETCH_RETRY_INTERVAL_MS="${ART_FILTERED_STORE_FETCH_RETRY_INTERVAL_MS:-2000}"
export ART_FILTERED_STORE_DEBUG="${ART_FILTERED_STORE_DEBUG:-false}"
export SESSION_TOKEN="${SESSION_TOKEN:-LSP67d39bb4975c4d069ff43a164f84737c}"
export USE_FETCH_ORDER_CONTEXT="${USE_FETCH_ORDER_CONTEXT:-false}"
unset FETCH_ORDER_CONTEXT_ENABLED
unset ART_FETCH_ORDER_CONTEXT_ENABLED

CRON_MODE="${ART_FINAL_STORE_CRON_MODE:-filtered}"
CRON_SCRIPT="${ART_FINAL_STORE_CRON_SCRIPT:-}"

if [[ -z "${CRON_SCRIPT}" ]]; then
  case "${CRON_MODE}" in
    filtered)
      CRON_SCRIPT="scripts/art-final-store-filtered-cron.js"
      ;;
    standard)
      CRON_SCRIPT="scripts/art-final-store-cron.js"
      ;;
    *)
      echo "$(date -Is) invalid ART_FINAL_STORE_CRON_MODE=${CRON_MODE}" >> "${CRON_LOG_FILE}"
      exit 1
      ;;
  esac
fi

{
  echo
  echo "===== $(date -Is) art-final-store cron start ====="
  echo "mode=${CRON_MODE} script=${CRON_SCRIPT}"
  if [[ -x /nix/store/6b8rp3jvsq1am7d0bx8xz2dpyb45nbp2-nodejs-26.2.0/bin/node ]]; then
    /nix/store/6b8rp3jvsq1am7d0bx8xz2dpyb45nbp2-nodejs-26.2.0/bin/node "${CRON_SCRIPT}"
  elif command -v node >/dev/null 2>&1; then
    node "${CRON_SCRIPT}"
  elif command -v nix >/dev/null 2>&1; then
    nix develop --command node "${CRON_SCRIPT}"
  else
    echo "node is not available on PATH, and nix was not found either"
    exit 127
  fi
  echo "===== $(date -Is) art-final-store cron end ====="
} >> "${CRON_LOG_FILE}" 2>&1
