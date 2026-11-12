#!/bin/bash
# 上传 Release 剩余资产。已上传的 payload.sha256 跳过。
# 6.9GB 分卷耗时较长，逐卷上传并记录进度到日志。
set -u

OUT=/c/Users/DR/Downloads/DSH/dsh-pack-rust/_build/out
REPO=DRDRDRRDDRDR/dsh-pack-installer
RELEASE_ID=442836525
LOG=/c/Users/DR/Downloads/DSH/dsh-pack-rust/_upload.log

TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null | grep '^password=' | cut -d= -f2-)
if [ -z "${TOKEN:-}" ]; then echo "NO_TOKEN" >>"$LOG"; exit 1; fi

: >"$LOG"
echo "upload start $(date -Is)" >>"$LOG"

upload_one() {
  f="$1"
  name=$(basename "$f")
  size=$(stat -c%s "$f")
  echo "[$(date +%H:%M:%S)] start $name bytes=$size" >>"$LOG"
  code=$(curl -s -o /tmp/up-resp.json -w '%{http_code}' \
    -X POST \
    -H "Authorization: token $TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" \
    "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$name" \
    --max-time 7200)
  echo "[$(date +%H:%M:%S)] $name code=$code" >>"$LOG"
  if [ "$code" != "201" ]; then
    head -c 300 /tmp/up-resp.json >>"$LOG"
    echo "" >>"$LOG"
    return 1
  fi
  return 0
}

FAILED=0
for f in "$OUT"/payload.tar.001 "$OUT"/payload.tar.002 "$OUT"/payload.tar.003 "$OUT"/payload.tar.004 "$OUT"/dsh-pack-installer.exe "$OUT"/manifest.json "$OUT"/volumes.json; do
  [ -f "$f" ] || continue
  upload_one "$f" || FAILED=$((FAILED+1))
done

echo "upload done $(date -Is) failed=$FAILED" >>"$LOG"
echo "UPLOAD_RESULT failed=$FAILED" >>"$LOG"
