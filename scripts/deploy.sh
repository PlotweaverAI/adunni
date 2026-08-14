#!/bin/bash
set -e

# Adunni VPS deploy script — git pull + docker compose rebuild
# Usage: ssh root@<vps> "cd /opt/adunni && bash scripts/deploy.sh"

cd /opt/adunni

echo "=== Adunni Deploy ==="
echo "[1/4] Pulling latest from origin/main..."
git pull origin main

echo "[2/4] Building images..."
docker compose -f docker-compose.yml -f docker-compose.prod.yml build

echo "[3/4] Starting services..."
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

echo "[4/4] Checking status..."
sleep 3
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps

echo ""
echo "=== Deploy Complete ==="
