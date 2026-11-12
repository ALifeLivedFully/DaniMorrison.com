#!/usr/bin/env bash
# Exports the shop worker's remote D1 database to a local SQLite database file.
# D1's export API only produces SQL text, so this script fetches that dump with
# export-d1.sh and then imports it into a .sqlite file — using the sqlite3 CLI
# when available, otherwise Python's built-in sqlite3 module.
#
# The database file contains every row — including the shops row with the
# Stripe keys — so never commit it or share it. The default output lives in the
# gitignored workers/shop/exports/ directory.
#
# Usage:
#   ./workers/shop/scripts/export-d1-sqlite.sh
#   OUTPUT=/tmp/orders.sqlite ./workers/shop/scripts/export-d1-sqlite.sh
#   DUMP_TABLES=orders,order_items ./workers/shop/scripts/export-d1-sqlite.sh
#   NO_DATA=1 ./workers/shop/scripts/export-d1-sqlite.sh       # schema only
#
# Env options are passed through to export-d1.sh: SECRETSPEC_PROFILE,
# ACCOUNT_ID, DATABASE_ID, DUMP_TABLES, NO_DATA, NO_SCHEMA, COMPATIBILITY.
# Here OUTPUT names the .sqlite file (default under workers/shop/exports/).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worker_dir="$(cd "$script_dir/.." && pwd)"

OUTPUT="${OUTPUT:-$worker_dir/exports/orders-$(date +%Y%m%d-%H%M%S).sqlite}"
case "$OUTPUT" in
  /*) ;;
  *) OUTPUT="$PWD/$OUTPUT" ;;
esac
mkdir -p "$(dirname "$OUTPUT")"

sql_file="$(mktemp "${TMPDIR:-/tmp}/d1-export-XXXXXX.sql")"
trap 'rm -f "$sql_file"' EXIT

OUTPUT="$sql_file" "$script_dir/export-d1.sh"

rm -f "$OUTPUT"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$OUTPUT" < "$sql_file"
else
  python3 - "$OUTPUT" "$sql_file" <<'PY'
import sqlite3, sys

path, dump = sys.argv[1], sys.argv[2]
db = sqlite3.connect(path)
with open(dump, encoding="utf-8") as fh:
    db.executescript(fh.read())
db.close()
PY
fi

if [ ! -s "$OUTPUT" ]; then
  echo "Failed to build the SQLite database: $OUTPUT" >&2
  exit 1
fi

bytes="$(wc -c < "$OUTPUT" | tr -d ' ')"
echo
echo "SQLite database written to:"
echo "  $OUTPUT ($bytes bytes)"
echo
echo "WARNING: the database contains every row, including the shops row with"
echo "the Stripe keys. Do not commit it or share it."
