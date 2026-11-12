#!/usr/bin/env bash
# Exports the shop worker's remote D1 database to a local SQL file using the
# Cloudflare D1 export API:
#   https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/
#
# The dump contains every row — including the shops row with the Stripe keys —
# so never commit it or share it. The default output lives in the gitignored
# workers/shop/exports/ directory.
#
# Usage:
#   ./workers/shop/scripts/export-d1.sh
#   OUTPUT=/tmp/orders.sql ./workers/shop/scripts/export-d1.sh
#   DUMP_TABLES=orders,order_items ./workers/shop/scripts/export-d1.sh
#   NO_DATA=1 ./workers/shop/scripts/export-d1.sh              # schema only
#   NO_SCHEMA=1 ./workers/shop/scripts/export-d1.sh            # data only
#   COMPATIBILITY=sqlite3_cli_only ./workers/shop/scripts/export-d1.sh
#
# The CLOUDFLARE_API_TOKEN is read from the secretspec keyring (it needs D1
# Read access). Overrides: SECRETSPEC_PROFILE, ACCOUNT_ID, DATABASE_ID.
#
# The API polls for completion; an in-progress export is cancelled unless it is
# polled, so this script keeps polling until the export reports "complete". The
# signed download URL is valid for one hour and is downloaded immediately.
set -euo pipefail

PROFILE="${SECRETSPEC_PROFILE:-production}"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if [ "${D1_EXPORT_REENTRY:-}" = "1" ]; then
    echo "CLOUDFLARE_API_TOKEN is not set in the secretspec '$PROFILE' profile." >&2
    echo "Set it first: secretspec set CLOUDFLARE_API_TOKEN -P $PROFILE" >&2
    exit 1
  fi
  export D1_EXPORT_REENTRY=1
  exec secretspec run --profile "$PROFILE" \
    --reason "export the shop worker's D1 database to SQL" \
    -- "$0" "$@"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worker_dir="$(cd "$script_dir/.." && pwd)"
wrangler_file="$worker_dir/wrangler.jsonc"

read_setting() {
  grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]+\"" "$wrangler_file" \
    | head -1 | sed -E 's/.*"([^"]+)"$/\1/'
}

ACCOUNT_ID="${ACCOUNT_ID:-$(read_setting account_id)}"
DATABASE_ID="${DATABASE_ID:-$(read_setting database_id)}"
if [ -z "$ACCOUNT_ID" ] || [ -z "$DATABASE_ID" ]; then
  echo "Could not read account_id/database_id from $wrangler_file." >&2
  echo "Pass them explicitly: ACCOUNT_ID=... DATABASE_ID=... $0" >&2
  exit 1
fi

OUTPUT="${OUTPUT:-$worker_dir/exports/orders-$(date +%Y%m%d-%H%M%S).sql}"
mkdir -p "$(dirname "$OUTPUT")"

api_url="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database/$DATABASE_ID/export"

request_body() {
  python3 - <<'PY'
import json, os

body = {"output_format": "polling"}
bookmark = os.environ.get("BOOKMARK", "")
if bookmark:
    body["current_bookmark"] = bookmark

options = {}
tables = [t.strip() for t in os.environ.get("DUMP_TABLES", "").split(",") if t.strip()]
if tables:
    options["tables"] = tables
if os.environ.get("NO_DATA") == "1":
    options["no_data"] = True
if os.environ.get("NO_SCHEMA") == "1":
    options["no_schema"] = True
compatibility = os.environ.get("COMPATIBILITY", "")
if compatibility:
    options["compatibility"] = compatibility
if options:
    body["dump_options"] = options

print(json.dumps(body))
PY
}

# Prints the export response summary one field per line:
# success, status, at_bookmark, error, signed_url, filename, errors
parse_response() {
  RESPONSE="$1" python3 - <<'PY'
import json, os, sys

def clean(value):
    return str(value).replace("\r", " ").replace("\n", " ")

raw = os.environ.get("RESPONSE", "")
try:
    data = json.loads(raw)
except Exception:
    print("0")
    print("parse_error")
    print("")
    print("not JSON: " + clean(raw)[:200])
    print("")
    print("")
    print("")
    sys.exit(0)

result = data.get("result") or {}
inner = result.get("result") or {}
errors = "; ".join(str(e.get("message", e)) for e in (data.get("errors") or []))
for value in [
    "1" if data.get("success") else "0",
    result.get("status") or "",
    result.get("at_bookmark") or "",
    result.get("error") or "",
    inner.get("signed_url") or "",
    inner.get("filename") or "",
    errors,
]:
    print(clean(value))
PY
}

BOOKMARK=""
attempt=1
max_attempts=300
signed_url=""
filename=""

while [ "$attempt" -le "$max_attempts" ]; do
  body="$(request_body)"
  response="$(curl -sS -X POST "$api_url" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$body")"
  parsed="$(parse_response "$response")"
  mapfile -t fields <<< "$parsed"
  ok="${fields[0]:-}"
  status="${fields[1]:-}"
  bookmark="${fields[2]:-}"
  export_error="${fields[3]:-}"
  signed_url="${fields[4]:-}"
  filename="${fields[5]:-}"
  errors="${fields[6]:-}"

  case "$status" in
    complete)
      break
      ;;
    error)
      echo "D1 export failed: ${export_error:-$errors}" >&2
      exit 1
      ;;
    *)
      if [ "$ok" != "1" ]; then
        echo "D1 export request failed: ${errors:-unknown error}" >&2
        exit 1
      fi
      if [ -n "$bookmark" ]; then
        BOOKMARK="$bookmark"
      fi
      if [ "$attempt" = "1" ]; then
        echo "Export started, polling for completion..."
      fi
      attempt=$((attempt + 1))
      sleep 2
      ;;
  esac
done

if [ -z "$signed_url" ]; then
  echo "D1 export did not return a download URL." >&2
  exit 1
fi

echo "Downloading ${filename:-export} ..."
curl -sS -f -o "$OUTPUT" "$signed_url"
if [ ! -s "$OUTPUT" ]; then
  echo "Download failed or produced an empty file: $OUTPUT" >&2
  exit 1
fi

bytes="$(wc -c < "$OUTPUT" | tr -d ' ')"
echo "Exported D1 '$DATABASE_ID' to:"
echo "  $OUTPUT ($bytes bytes)"
echo
echo "WARNING: the dump contains every row, including the shops row with the"
echo "Stripe keys. Do not commit it or share it."
