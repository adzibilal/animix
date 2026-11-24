#!/bin/sh
cd "$(dirname "$0")"
# Node ignores the system CA store: behind a network that inspects TLS (WARP, Zscaler, a company proxy) every voice-over provider fails with
# "fetch failed" unless Node is handed the system bundle.
if [ -z "$NODE_EXTRA_CA_CERTS" ]; then
  for ca in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem /etc/pki/tls/certs/ca-bundle.crt; do [ -f "$ca" ] && export NODE_EXTRA_CA_CERTS="$ca" && break; done
fi
curl -s -o /dev/null http://localhost:4790/api/catalog || (nohup node video-studio/vs.mjs serve > video-studio/server.log 2>&1 &) ; sleep 2
URL=http://localhost:4790
if grep -qi microsoft /proc/version 2>/dev/null; then
  # WSL: open Chrome on the Windows side (WSL2 forwards localhost)
  cmd.exe /c start chrome "$URL" 2>/dev/null
else
  (command -v open >/dev/null && open "$URL") || xdg-open "$URL"
fi
