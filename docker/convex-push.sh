#!/bin/sh
set -e

KEY=$(cat /init/admin_key | tr -d '[:space:]')

if [ -z "$KEY" ]; then
  echo "ERROR: Admin key is empty. Check generate-key container."
  exit 1
fi

echo "Admin key loaded."

export CONVEX_SELF_HOSTED_URL=http://backend:3210
export CONVEX_SELF_HOSTED_ADMIN_KEY="$KEY"
export CONVEX_TMPDIR=/app/.convex-tmp
mkdir -p /app/.convex-tmp

cd /app

# Install deps if node_modules is empty (local dev with volume mount)
if [ ! -d "node_modules/convex" ]; then
  echo "Installing dependencies..."
  npm install --prefer-offline 2>&1 | tail -3
fi

# Convex requires all env vars referenced by auth.config.ts to be present.
# Keep Clerk optional by defaulting to a disabled sentinel.
npx convex env set CLERK_JWT_ISSUER_DOMAIN "${CLERK_JWT_ISSUER_DOMAIN:-disabled}" >/dev/null

# Push Convex functions
npx convex dev --once

# If .env is mounted (local dev), write admin key back for host-side usage
if [ -f /app/.env ]; then
  if grep -q '^CONVEX_SELF_HOSTED_ADMIN_KEY=' /app/.env 2>/dev/null; then
    tmp=$(mktemp)
    while IFS= read -r line; do
      case "$line" in
        CONVEX_SELF_HOSTED_ADMIN_KEY=*) echo "CONVEX_SELF_HOSTED_ADMIN_KEY=$KEY" ;;
        *) echo "$line" ;;
      esac
    done < /app/.env > "$tmp"
    mv "$tmp" /app/.env
  else
    echo "CONVEX_SELF_HOSTED_ADMIN_KEY=$KEY" >> /app/.env
  fi

  # Convex CLI overwrites .env.local with container-internal URLs — fix for host
  printf 'VITE_CONVEX_URL=http://127.0.0.1:3210\nVITE_CONVEX_SITE_URL=http://127.0.0.1:3211\n' > /app/.env.local
fi

echo "Convex functions pushed."
