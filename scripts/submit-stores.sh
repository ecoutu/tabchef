#!/usr/bin/env bash
# Upload the zip built by `npm run zip` to the Chrome Web Store and submit it for review, when the store secrets are
# set (semantic-release's publish step; spec §11.1). Pass --dry-run to only check the credentials.
# Chrome Web Store API v2 with a service account: v1.1 (OAuth refresh token) was shut down on 2026-10-15.
set -euo pipefail
shopt -s failglob

vars=(CHROME_EXTENSION_ID CHROME_PUBLISHER_ID CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL CHROME_SERVICE_ACCOUNT_PRIVATE_KEY)
missing=()
for v in "${vars[@]}"; do
  [[ -n "${!v:-}" ]] || missing+=("$v")
done

if [[ ${#missing[@]} == "${#vars[@]}" ]]; then
  echo "Chrome Web Store secrets not set; skipping. The release is on GitHub only."
  exit 0
fi
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Chrome Web Store secrets incomplete; missing: ${missing[*]}" >&2
  exit 1
fi

npx wxt submit "$@" --chrome-api-version v2 --chrome-zip .output/*-chrome.zip
