#!/bin/sh
# Restart the local SCCE server, killing whatever actually holds the port (pkill does not match on Windows).
cd "$(dirname "$0")/.."
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*server/dist/index.js*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" 2>/dev/null
sleep 3
rm -rf .scce/traces
SCCE_TRACE=1 nohup node packages/server/dist/index.js > .tmp-server.log 2>&1 &
sleep 8
for i in $(seq 1 30); do
  ok=$(curl -s -m 5 http://127.0.0.1:3873/api/ready | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).ok)}catch(e){console.log('x')}})")
  if [ "$ok" = "true" ]; then echo "ready"; exit 0; fi
  sleep 10
done
echo "NOT READY"; tail -5 .tmp-server.log; exit 1
