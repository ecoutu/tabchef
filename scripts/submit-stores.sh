#!/usr/bin/env bash
# Upload the zip built by `npm run zip` to the Chrome Web Store and submit it for review (semantic-release's publish
# step; spec §11.1). A previous version still pending review is cancelled first. Pass --dry-run to only check the
# credentials.
#
# Keyless: CI federates into the cws-publisher service account (through the tabchef GCP project's `github` workload identity pool) and passes a
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

# A version still in review locks the item's draft ("Cancel review ... letting you make changes to your draft"), so the
# upload would fail after the GitHub release is out. --chrome-cancel-pending cancels that review first and this version
# starts a new one (releases in quick succession each restart the review: space them out).
#
# In GitHub Actions the item's store state before and after the submission goes to the run summary, so a cancelled
# review or a rejection shows without the developer dashboard. Best effort: an unreadable status only warns.
fetch_status() {
  curl -fsS -H "Authorization: Bearer $CHROME_SERVICE_ACCOUNT_ACCESS_TOKEN" \
    "https://chromewebstore.googleapis.com/v2/publishers/$CHROME_PUBLISHER_ID/items/$CHROME_EXTENSION_ID:fetchStatus" \
    || { echo "::warning::Could not read the Chrome Web Store status for the run summary." >&2; echo 'null'; }
}
# One table row: each revision's state and versions ("—" when there is none), a partial rollout with its percentage.
status_row() {
  jq -r --arg label "$1" '
    def rev: if . == null then "—" else
      ([.state] + ((.distributionChannels // []) | map(.crxVersion
        + (if (.deployPercentage // 100) < 100 then " (\(.deployPercentage)%)" else "" end))) | join(" ")) end;
    if . == null then "| \($label) | unknown | unknown |"
    else "| \($label) | \(.publishedItemRevisionStatus | rev) | \(.submittedItemRevisionStatus | rev) |" end' <<<"$2"
}
# Notes under the table: a takedown or policy warning (from the status after the submission).
status_notes() {
  jq -r 'if . == null then empty else
    (if .takenDown then "\n**The item is taken down.**" else empty end),
    (if .warned then "\n**The item has a policy warning.** See the developer dashboard." else empty end) end' <<<"$1"
}

summary="${GITHUB_STEP_SUMMARY:-}"
[[ -n "$summary" ]] && before=$(fetch_status)
rc=0
npx wxt submit "$@" --chrome-api-version v2 --chrome-cancel-pending --chrome-zip .output/*-chrome.zip || rc=$?
if [[ -n "$summary" ]]; then
  after=$(fetch_status)
  {
    echo '### Chrome Web Store'
    echo
    echo '| | Published | Submitted |'
    echo '|---|---|---|'
    status_row Before "$before"
    status_row After "$after"
    status_notes "$after"
  } >>"$summary"
fi
exit "$rc"
