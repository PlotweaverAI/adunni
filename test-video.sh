#!/bin/bash
TOKEN=$(curl -s -X POST http://localhost:30000/v1/auth/demo \
  -H "Content-Type: application/json" \
  -d '{"clientId":"savanna-bank"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo "Token: ${TOKEN:0:20}..."

echo "--- Creating video conversation ---"
curl -s -X POST http://localhost:30000/v1/video/conversation \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"sessionId":"test-session-123"}'

echo
echo "--- Server logs ---"
docker logs adunni-api-gateway-1 --tail 10
