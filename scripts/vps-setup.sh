#!/bin/bash
set -e

echo "=== Adunni VPS Setup ==="

# 1. Create project directory
echo "[1/7] Creating project directory..."
mkdir -p /root/adunni
cd /root/adunni

# 2. Install Docker via dnf (AlmaLinux/RHEL compatible)
if ! command -v docker &> /dev/null; then
  echo "[2/7] Installing Docker via dnf..."
  dnf install -y dnf-plugins-core
  dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable docker
  systemctl start docker
  echo "Docker installed."
else
  echo "[2/7] Docker already installed."
fi

# 3. Install Docker Compose plugin if not present
if ! docker compose version &> /dev/null 2>&1; then
  echo "[3/7] Docker Compose plugin not found, installing standalone..."
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  echo "Docker Compose installed."
else
  echo "[3/7] Docker Compose already available."
fi

# 4. Clone the repo
echo "[4/7] Cloning adunni repo..."
if [ -d ".git" ]; then
  echo "Repo exists, pulling latest..."
  git pull origin main || true
else
  git clone https://github.com/PlotweaverAI/adunni.git .
fi

# 5. Copy env file
echo "[5/7] Creating .env file..."
cat > /root/adunni/.env << 'ENVFILE'
# Database
POSTGRES_DB=adunni
POSTGRES_USER=adunni
POSTGRES_PASSWORD=adunni_prod_pass_change_me

# JWT
JWT_SECRET=change_this_to_a_random_64_char_string

# Encryption
ENCRYPTION_KEY=change_this_to_a_random_64_char_string

# Service URLs (internal docker network)
ASR_SERVICE_URL=http://asr-service:3001
TTS_SERVICE_URL=http://tts-service:3002
ORCHESTRATOR_URL=http://orchestrator:3003
ACTION_EXECUTOR_URL=http://action-executor:3004
CONFIG_SERVICE_URL=http://config-service:3005
SESSION_STORE_URL=http://session-store:3006

# Database URL
DATABASE_URL=postgres://adunni:adunni_prod_pass_change_me@postgres:5432/adunni

# Redis
REDIS_URL=redis://redis:6379

# TLS (leave empty for now, will configure later)
TLS_CERT_PATH=
TLS_KEY_PATH=
ENVFILE

echo ".env created. EDIT IT before going live!"

# 6. Build and start
echo "[6/7] Building and starting services..."
docker compose build
docker compose up -d

# 7. Verify
echo "[7/7] Checking service status..."
sleep 5
docker compose ps

echo ""
echo "=== Setup Complete ==="
echo "IMPORTANT: Edit /root/adunni/.env with secure passwords before production use!"
