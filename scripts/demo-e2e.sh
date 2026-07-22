#!/usr/bin/env bash
# End-to-end demo: spins up Postgres + Redis + the authorizer with a locally generated
# JWKS, then runs the authorize -> commit flow. Leaves the stack running for screenshots.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRET="local-dev-secret"
NET=sa-demo-net; PG=sa-demo-pg; RD=sa-demo-redis; APP=sa-demo-app

cleanup() { docker rm -f "$APP" "$PG" "$RD" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
cleanup

echo "Building image..."; docker build -t subscription-authorizer:demo "$ROOT" >/dev/null
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=authorizer -e POSTGRES_PASSWORD=authorizer -e POSTGRES_DB=authorizer postgres:16-alpine >/dev/null
docker run -d --name "$RD" --network "$NET" redis:7-alpine >/dev/null

# Generate an RSA keypair + JWKS + a signed JWT (built-in node crypto, no deps).
TMP="$(mktemp -d)"
cat > "$TMP/keygen.js" <<'JS'
const crypto = require('crypto'), fs = require('fs');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'demo-key';
const jwk = publicKey.export({ format: 'jwk' }); jwk.kid = kid; jwk.alg = 'RS256'; jwk.use = 'sig';
fs.writeFileSync('/out/jwks.json', JSON.stringify({ keys: [jwk] }));
const b = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000), iss = 'https://issuer.local/', aud = 'api://main-app';
const sign = (p) => { const h = b({ alg: 'RS256', typ: 'JWT', kid }), pl = b(p), d = h + '.' + pl;
  return d + '.' + crypto.sign('RSA-SHA256', Buffer.from(d), privateKey).toString('base64url'); };
fs.writeFileSync('/out/active.jwt', sign({ sub: 'user-1', tenantId: 'tenant-active', iss, aud, iat: now, exp: now + 3600 }));
JS
docker run --rm -v "$TMP":/out node:20-alpine node /out/keygen.js >/dev/null
JWKS="$(cat "$TMP/jwks.json")"

docker run -d --name "$APP" --network "$NET" -p 8080:8080 \
  -e DATABASE_URL="postgres://authorizer:authorizer@$PG:5432/authorizer" -e REDIS_URL="redis://$RD:6379" \
  -e JWKS_JSON="$JWKS" -e JWT_ISSUER=https://issuer.local/ -e JWT_AUDIENCE=api://main-app \
  -e INTERNAL_SERVICE_TOKEN_SECRET="$SECRET" -e NODE_ENV=production -e LOG_LEVEL=warn \
  subscription-authorizer:demo >/dev/null

echo "Waiting for authorizer..."
for i in $(seq 1 40); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/health/ready 2>/dev/null)" = "200" ] && break; sleep 1; done
echo "ready => $(curl -s http://localhost:8080/health/ready)"; echo

ACTIVE="$(cat "$TMP/active.jwt")"
itoken() { local ts sig; ts=$(date +%s); sig=$(printf "%s" "$ts" | openssl dgst -sha256 -hmac "$SECRET" -binary | openssl base64 -A | tr '+/' '-_' | tr -d '='); echo "$ts.$sig"; }

echo "── 1) AUTHORIZE  (POST /api/ai/generate) ──"
curl -s -D - -o /dev/null \
  -H "Authorization: Bearer $ACTIVE" -H "X-Original-Method: POST" -H "X-Original-URI: /api/ai/generate" -H "X-Request-ID: demo-1" \
  http://localhost:8080/internal/authorize | tr -d '\r' | grep -iE '^HTTP/|^x-plan|^x-quota|^x-estimated'
echo
echo "── 2) COMMIT actual usage (1200 of the 3000 reserved; rest is released) ──"
curl -s -H "X-Internal-Token: $(itoken)" -H 'Content-Type: application/json' \
  -d '{"reservationId":"demo-1","requestId":"demo-1","actualUnits":1200}' \
  http://localhost:8080/internal/quota/commit; echo; echo

echo "Stack left running for screenshots."
echo "  metrics:  curl -s localhost:8080/metrics | grep -E 'quota_|authorizer_dependency'"
echo "  cleanup:  docker rm -f $APP $PG $RD && docker network rm $NET"
