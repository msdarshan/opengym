#!/usr/bin/env bash
# Sets up openGym on an old PC running Ubuntu Server (or Debian) and publishes it
# on a free HTTPS address with Tailscale Funnel. Safe to run more than once.
#
#   bash setup-old-pc.sh
#
# Run it as your normal user (not root); it asks for your sudo password.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/alexpcosta/opengym.git}"
APP_DIR="${APP_DIR:-$HOME/openGym}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/opengym-backups}"
PORT=8080

step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx  %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not root (it uses sudo where needed)."
case "$(uname -m)" in
  x86_64|aarch64|arm64) ;;
  *) die "This PC is $(uname -m). Docker needs a 64-bit CPU (x86_64 or arm64)." ;;
esac
command -v apt-get >/dev/null || die "This script expects Ubuntu or Debian (apt-get not found)."

step "1/8 Installing basic tools and automatic security updates"
# Ubuntu's automatic updater often holds the package lock; make every apt-get (including
# the one inside Docker's installer) wait for it instead of failing.
echo 'DPkg::Lock::Timeout "1800";' | sudo tee /etc/apt/apt.conf.d/99-wait-for-lock >/dev/null
sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates python3 unattended-upgrades
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

step "1b/8 Freeing space on the system disk"
sudo apt-get clean
sudo apt-get -y autoremove --purge
RC_PKGS="$(dpkg -l | awk '/^rc/{print $2}')"
[ -z "$RC_PKGS" ] || sudo dpkg --purge $RC_PKGS
sudo journalctl --vacuum-size=100M >/dev/null
if command -v snap >/dev/null; then
  snap list --all | awk '/disabled/{print $1, $3}' | while read -r name rev; do
    sudo snap remove "$name" --revision="$rev" >/dev/null || true
  done
fi
df -h / "$HOME" | sed 1d

# Old PCs often have a small system partition and a big /home. Put Docker's images and
# a swap file on /home when it has clearly more room than /.
root_free_kb="$(df --output=avail / | tail -1)"
home_free_kb="$(df --output=avail "$HOME" | tail -1)"
USE_HOME=0
if [ "$(df --output=source / | tail -1)" != "$(df --output=source "$HOME" | tail -1)" ] \
   && [ "$home_free_kb" -gt $((root_free_kb * 2)) ]; then
  USE_HOME=1
fi

mem_kb="$(awk '/MemTotal/{print $2}' /proc/meminfo)"
swap_kb="$(awk '/SwapTotal/{print $2}' /proc/meminfo)"
if [ "$mem_kb" -lt 3500000 ] && [ "$swap_kb" -lt 2000000 ]; then
  SWAPFILE=/swapfile-opengym
  [ "$USE_HOME" = 1 ] && SWAPFILE="/home/swapfile-opengym"
  if [ ! -f "$SWAPFILE" ]; then
    echo "Low RAM: adding a 2 GB swap file at $SWAPFILE so the build doesn't run out of memory."
    sudo fallocate -l 2G "$SWAPFILE"
    sudo chmod 600 "$SWAPFILE"
    sudo mkswap "$SWAPFILE" >/dev/null
  fi
  swapon --show=NAME --noheadings | grep -qx "$SWAPFILE" || sudo swapon "$SWAPFILE"
  grep -q "^$SWAPFILE " /etc/fstab || echo "$SWAPFILE none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi

step "2/8 Installing Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
fi
if [ "$USE_HOME" = 1 ] && [ ! -f /etc/docker/daemon.json ]; then
  echo "Storing Docker data on /home/docker (more free space there)."
  sudo mkdir -p /etc/docker /home/docker
  echo '{ "data-root": "/home/docker" }' | sudo tee /etc/docker/daemon.json >/dev/null
  sudo systemctl restart docker
fi
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

step "3/8 Installing Tailscale"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
sudo systemctl enable --now tailscaled
if ! sudo tailscale status >/dev/null 2>&1; then
  echo "Open the link below in any browser and log in to Tailscale to add this PC:"
  sudo tailscale up
fi

HOST="$(sudo tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
[ -n "$HOST" ] || die "Could not read this PC's Tailscale address. In the Tailscale admin console, turn on MagicDNS (DNS tab) and re-run."
echo "This PC's public address will be: https://$HOST"

step "4/8 Downloading openGym into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

step "5/8 Configuring .env for https://$HOST"
[ -f .env ] || cp .env.example .env
sed -i "s|^RP_ID=.*|RP_ID=$HOST|; s|^ORIGIN=.*|ORIGIN=https://$HOST|; s|^WEB_PORT=.*|WEB_PORT=$PORT|" .env
grep -E '^(RP_ID|ORIGIN|WEB_PORT)=' .env

step "6/8 Building and starting openGym (first build can take 10-20 minutes on an old PC)"
sudo docker compose up -d --build
for _ in $(seq 1 60); do
  curl -fs "http://localhost:$PORT/api/health" >/dev/null && break
  sleep 2
done
curl -fs "http://localhost:$PORT/api/health" >/dev/null || die "openGym did not start. Check: sudo docker compose -f $APP_DIR/docker-compose.yml logs"
echo "openGym is running locally on port $PORT."

step "7/8 Keeping the PC awake and backing up data daily"
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null
# Laptops: keep running with the lid closed.
sudo mkdir -p /etc/systemd/logind.conf.d
printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n' \
  | sudo tee /etc/systemd/logind.conf.d/opengym-lid.conf >/dev/null
mkdir -p "$BACKUP_DIR"
CRON_LINE="30 3 * * * tar czf $BACKUP_DIR/opengym-\$(date +\\%F).tar.gz -C $APP_DIR data && find $BACKUP_DIR -name 'opengym-*.tar.gz' -mtime +14 -delete # opengym-backup"
{ sudo crontab -l 2>/dev/null | grep -v '# opengym-backup' || true; echo "$CRON_LINE"; } | sudo crontab -
echo "Daily backup at 03:30 into $BACKUP_DIR (last 14 days kept)."

step "8/8 Publishing on https://$HOST with Tailscale Funnel"
echo "If Tailscale prints a link to enable HTTPS or Funnel, open it, approve, and this step continues."
sudo tailscale funnel --bg "$PORT"

cat <<EOF

=============================================================
 openGym is live at:  https://$HOST
=============================================================
 Next:
  1. Open that address on your phone and tap "Create profile".
  2. Lock sign-ups (recommended): find your user id with
       sudo python3 -c 'import json;print([u["id"] for u in json.load(open("$APP_DIR/data/db.json"))["users"]])'
     then add to $APP_DIR/.env:
       ADMIN_UIDS=<your id>
       INVITE_ONLY=1
     and run:  cd $APP_DIR && sudo docker compose up -d
  3. In the PC's BIOS, set "Restore on AC power loss" to "Power On".

 Backups: $BACKUP_DIR   Logs: cd $APP_DIR && sudo docker compose logs -f
EOF
