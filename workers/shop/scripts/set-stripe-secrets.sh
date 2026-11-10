#!/usr/bin/env bash
# Writes the Stripe API key and webhook signing secret from the local
# secretspec keyring into the shop worker's remote D1 shops row. The values
# themselves are never printed or committed; only their presence is shown.
#
# Usage:
#   secretspec set STRIPE_SECRET_KEY
#   secretspec set STRIPE_WEBHOOK_SECRET
#   ./workers/shop/scripts/set-stripe-secrets.sh
#
# Forks: override SHOP_ID (and DB_NAME if needed) to target another row.
set -euo pipefail

SHOP_ID="${SHOP_ID:-danimorrison}"
DB_NAME="${DB_NAME:-orders}"

if [ -z "${STRIPE_SECRET_KEY:-}" ] && [ -z "${STRIPE_WEBHOOK_SECRET:-}" ]; then
  if [ "${STRIPE_SECRETS_REENTRY:-}" = "1" ]; then
    echo "Neither STRIPE_SECRET_KEY nor STRIPE_WEBHOOK_SECRET is set in the" >&2
    echo "secretspec production profile. Set them first:" >&2
    echo "  secretspec set STRIPE_SECRET_KEY" >&2
    echo "  secretspec set STRIPE_WEBHOOK_SECRET" >&2
    exit 1
  fi
  export STRIPE_SECRETS_REENTRY=1
  exec secretspec run --profile production \
    --reason "apply the Stripe configuration to the shop worker's D1 shops row" \
    -- "$0" "$@"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(dirname "$script_dir")"

escape_sql() {
  printf "%s" "$1" | sed "s/'/''/g"
}

existing="$(wrangler d1 execute "$DB_NAME" --remote --json \
  --command "SELECT id FROM shops WHERE id = '$(escape_sql "$SHOP_ID")'")"
if ! printf "%s" "$existing" | grep -Fq "\"$SHOP_ID\""; then
  echo "Shop '$SHOP_ID' is not registered in the '$DB_NAME' database." >&2
  echo "Seed its shops row first (see the migration history for the columns)." >&2
  exit 1
fi

sql_file="$(mktemp)"
trap 'rm -f "$sql_file"' EXIT

key_mode="unset"
if [ -n "${STRIPE_SECRET_KEY:-}" ]; then
  key_mode="unknown format"
  case "$STRIPE_SECRET_KEY" in
    sk_test_*) key_mode="test" ;;
    sk_live_*) key_mode="live" ;;
  esac
fi

{
  printf "UPDATE shops SET updated_at = datetime('now')"
  if [ -n "${STRIPE_SECRET_KEY:-}" ]; then
    printf ", stripe_secret_key = '%s'" "$(escape_sql "$STRIPE_SECRET_KEY")"
  fi
  if [ -n "${STRIPE_WEBHOOK_SECRET:-}" ]; then
    printf ", stripe_webhook_secret = '%s'" "$(escape_sql "$STRIPE_WEBHOOK_SECRET")"
  fi
  printf " WHERE id = '%s';\n" "$(escape_sql "$SHOP_ID")"
} > "$sql_file"

wrangler d1 execute "$DB_NAME" --remote --file "$sql_file"

echo
echo "Shop '$SHOP_ID' is now configured with:"
echo "  Stripe API key mode: $key_mode"
if [ "$key_mode" = "test" ]; then
  echo "  NOTE: a test key cannot charge real cards. Before accepting real"
  echo "  payments, set the live key (secretspec set STRIPE_SECRET_KEY) and"
  echo "  re-run this script."
fi
wrangler d1 execute "$DB_NAME" --remote \
  --command "SELECT id, active, stripe_secret_key IS NOT NULL AS stripe_key_set, stripe_webhook_secret IS NOT NULL AS webhook_secret_set FROM shops WHERE id = '$(escape_sql "$SHOP_ID")'"
