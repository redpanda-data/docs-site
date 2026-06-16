#!/usr/bin/env bash
# Drives the full AS broker flow against the spike (mock upstream).
# Usage: BASE=http://localhost:9999 ./spike-test.sh
set -euo pipefail
BASE="${BASE:-http://localhost:9999}"
AS="$BASE/mcp-as"
CLIENT_REDIRECT="https://client.example/cb"

loc() { grep -i '^location:' | sed -E 's/^location:[[:space:]]*//I' | tr -d '\r'; }

echo "### 0. discovery + jwks"
curl -s "$AS/.well-known/oauth-authorization-server" | python3 -c "import sys,json;d=json.load(sys.stdin);print('issuer:',d['issuer']);print('upstream_mode:',d['_spike']['upstream_mode'])"
curl -s "$AS/jwks.json" | python3 -c "import sys,json;print('jwks kid:',json.load(sys.stdin)['keys'][0]['kid'])"

echo "### 1. client PKCE"
VERIFIER=$(python3 -c "import secrets;print(secrets.token_urlsafe(48))")
CHALLENGE=$(python3 -c "import hashlib,base64,sys;print(base64.urlsafe_b64encode(hashlib.sha256('$VERIFIER'.encode()).digest()).rstrip(b'=').decode())")
echo "verifier=${VERIFIER:0:12}…  challenge=${CHALLENGE:0:12}…"

echo "### 2. /authorize -> upstream"
L1=$(curl -s -D - -o /dev/null "$AS/authorize?response_type=code&client_id=spike-client&redirect_uri=$CLIENT_REDIRECT&state=xyz123&code_challenge=$CHALLENGE&code_challenge_method=S256" | loc)
echo "-> $L1"

echo "### 3. upstream login -> /callback"
L2=$(curl -s -D - -o /dev/null "$L1" | loc)
echo "-> $L2"

echo "### 4. /callback -> client redirect with OUR code"
L3=$(curl -s -D - -o /dev/null "$L2" | loc)
echo "-> $L3"
CODE=$(echo "$L3" | sed -E 's/.*[?&]code=([^&]+).*/\1/')
STATE=$(echo "$L3" | sed -E 's/.*[?&]state=([^&]+).*/\1/')
echo "our code=${CODE:0:12}…  state returned=$STATE  (expected xyz123)"

echo "### 5. /token (code + PKCE verifier) -> access token"
TOK=$(curl -s -X POST "$AS/token" -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=$CODE" \
  --data-urlencode "code_verifier=$VERIFIER" \
  --data-urlencode "redirect_uri=$CLIENT_REDIRECT" \
  --data-urlencode "client_id=spike-client")
echo "$TOK" | python3 -c "import sys,json;d=json.load(sys.stdin);print('token_type:',d.get('token_type'));print('access_token:',d.get('access_token','MISSING')[:40],'…')"
ACCESS=$(echo "$TOK" | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

echo "### 6. /protected with our token (resource-server validation)"
curl -s "$AS/protected" -H "authorization: Bearer $ACCESS" | python3 -m json.tool

echo "### 7. negatives"
echo -n "wrong PKCE verifier -> "; curl -s -o /dev/null -w "%{http_code}\n" -X POST "$AS/token" -H 'content-type: application/x-www-form-urlencoded' --data-urlencode "grant_type=authorization_code" --data-urlencode "code=$CODE" --data-urlencode "code_verifier=WRONG" --data-urlencode "redirect_uri=$CLIENT_REDIRECT"
echo -n "tampered token -> ";       curl -s -o /dev/null -w "%{http_code}\n" "$AS/protected" -H "authorization: Bearer ${ACCESS}tampered"
echo "(both should be 400/401)"
