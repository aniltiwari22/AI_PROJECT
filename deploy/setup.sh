#!/usr/bin/env bash
#
# Bootstraps Ashu Codex AI on a fresh Ubuntu 22.04/24.04 ARM64 or x86_64 server.
# Written for Oracle Cloud Always Free (4 Ampere cores / 24 GB), but nothing
# here is Oracle-specific.
#
#   curl -fsSL <raw-url>/deploy/setup.sh | bash
# or
#   git clone https://github.com/aniltiwari22/AI_PROJECT.git && bash AI_PROJECT/deploy/setup.sh
#
set -euo pipefail

APP_USER="${APP_USER:-$USER}"
APP_DIR="${APP_DIR:-$HOME/AI_PROJECT}"
REPO="${REPO:-https://github.com/aniltiwari22/AI_PROJECT.git}"
BRANCH="${BRANCH:-main}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --- sanity ----------------------------------------------------------------
say "Checking the machine"
TOTAL_GB=$(free -g | awk '/^Mem:/{print $2}')
CORES=$(nproc)
echo "    ${CORES} cores, ${TOTAL_GB} GB RAM, $(uname -m)"

# The model alone sits at ~5.5 GB resident. Below 8 GB the machine swaps and
# every answer takes minutes longer than it should.
if [ "$TOTAL_GB" -lt 7 ]; then
  echo "    WARNING: under 8 GB RAM. Ollama will swap and be very slow."
fi

# --- packages --------------------------------------------------------------
say "Installing packages"
sudo apt-get update -qq
# build-essential and python3 are for better-sqlite3: it tries a prebuilt
# binary first and compiles only if none matches this platform.
sudo apt-get install -y -qq git curl ca-certificates build-essential python3

if ! command -v node >/dev/null 2>&1; then
  say "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
echo "    node $(node -v)"

# --- ollama ----------------------------------------------------------------
if ! command -v ollama >/dev/null 2>&1; then
  say "Installing Ollama"
  curl -fsSL https://ollama.com/install.sh | sh
fi

# Ollama has no authentication of its own. Left on 0.0.0.0 anyone who finds the
# port can run your models, so it is pinned to loopback — only this server's
# own backend can reach it.
say "Binding Ollama to localhost only"
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<'EOF'
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
# Two 7B models resident will not fit alongside everything else; one at a time.
Environment="OLLAMA_MAX_LOADED_MODELS=1"
EOF
sudo systemctl daemon-reload
sudo systemctl restart ollama
sleep 3

say "Pulling models (~5 GB, this takes a while)"
ollama pull qwen2.5-coder:7b
ollama pull nomic-embed-text

# --- application -----------------------------------------------------------
if [ ! -d "$APP_DIR" ]; then
  say "Cloning"
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
else
  say "Updating"
  git -C "$APP_DIR" pull --ff-only
fi

say "Installing dependencies"
(cd "$APP_DIR/backend" && npm ci --omit=dev)
(cd "$APP_DIR/frontend" && npm ci && npm run build)

# --- configuration ---------------------------------------------------------
if [ ! -f "$APP_DIR/.env" ]; then
  say "Creating .env"
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"

  # A fresh password, not whatever the laptop uses. Printed once, stored only
  # as a scrypt hash.
  PASSWORD=$(node -e "
    const c=require('crypto');
    const a='abcdefghjkmnpqrstuvwxyz23456789';
    const p=n=>Array.from(c.randomBytes(n)).map(b=>a[b%a.length]).join('');
    console.log([p(5),p(5),p(5),p(5)].join('-'));
  ")
  HASH=$(cd "$APP_DIR/backend" && node src/auth/setup.js "$PASSWORD" | grep '^AUTH_PASSWORD_HASH=')

  sed -i '/^AUTH_PASSWORD_HASH=/d' "$APP_DIR/.env"
  printf '\n%s\n' "$HASH" >> "$APP_DIR/.env"

  echo ""
  echo "    ┌──────────────────────────────────────────────┐"
  echo "    │  Your password — write it down now:          │"
  printf  "    │  %-42s  │\n" "$PASSWORD"
  echo "    └──────────────────────────────────────────────┘"
  echo ""
  echo "    Change it later with: node src/auth/setup.js \"new password\""
else
  echo "    .env already exists, leaving it alone"
fi

say "Migrating any existing JSON stores"
(cd "$APP_DIR/backend" && node src/storage/migrate.js || true)

say "Done"
cat <<EOF

  Next, and none of it is optional:

  1. Set your domain in $APP_DIR/.env
         CORS_ORIGIN=https://your.domain
         TRUST_PROXY=1
     Without TRUST_PROXY the login lockout counts every attempt from the proxy
     as one client and locks everybody out after ten wrong guesses.

  2. Install the service and reverse proxy
         sudo cp $APP_DIR/deploy/ashu-backend.service /etc/systemd/system/
         sudo systemctl enable --now ashu-backend
         sudo cp $APP_DIR/deploy/Caddyfile /etc/caddy/Caddyfile
         sudo systemctl reload caddy

  3. Open only 80 and 443 in the Oracle security list.
     Never expose 5000 or 11434.

EOF
