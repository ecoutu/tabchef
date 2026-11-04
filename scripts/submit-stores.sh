#!/usr/bin/env bash
# Upload the zip built by `npm run zip` to the Chrome Web Store and submit it for review (semantic-release's publish
# step; spec §11.1). Pass --dry-run to only check the credentials.
#
# Keyless: CI federates into the cws-publisher service account (ecoutu-infra, github-tabchef pool) and passes a
# short-lived access token as CHROME_SERVICE_ACCOUNT_ACCESS_TOKEN; no service account key exists. Chrome Web Store
# API v2 (v1.1, with OAuth refresh tokens, was shut down on 2026-10-15).
set -euo pipefail
shopt -s failglob

if [[ -z "${CHROME_SERVICE_ACCOUNT_ACCESS_TOKEN:-}" ]]; then
  echo "Chrome Web Store publishing is not configured (no access token); skipping. The release is on GitHub only."
  exit 0
fi

missing=()
for v in CHROME_EXTENSION_ID CHROME_PUBLISHER_ID; do
  [[ -n "${!v:-}" ]] || missing+=("$v")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Chrome Web Store access token is set but the item is not; missing: ${missing[*]}" >&2
  exit 1
fi

npx wxt submit "$@" --chrome-api-version v2 --chrome-zip .output/*-chrome.zip
