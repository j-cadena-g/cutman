#!/usr/bin/env bash
# Renders deploy config and a temporary secrets file from process.env (op run),
# then runs remote migrations and wrangler deploy. Never commits secret files.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="${ROOT_DIR}/apps/web"
SECRETS_FILE="$(mktemp "${TMPDIR:-/tmp}/cutman-wrangler-secrets.XXXXXX.json")"
DEPLOY_CONFIG="${WEB_DIR}/.wrangler.deploy.jsonc"
# Workers Builds does not put node_modules/.bin on PATH for custom deploy scripts.
WRANGLER=(pnpm --filter @cutman/web exec wrangler)

cleanup() {
  rm -f "${SECRETS_FILE}"
}

trap cleanup EXIT

cd "${ROOT_DIR}"

pnpm run wrangler:deploy-config
node scripts/render-wrangler-secrets.mjs "${SECRETS_FILE}"

"${WRANGLER[@]}" d1 migrations apply cutman --remote --config "${DEPLOY_CONFIG}"
"${WRANGLER[@]}" deploy --config "${DEPLOY_CONFIG}" --secrets-file "${SECRETS_FILE}"
