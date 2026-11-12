#!/bin/bash
# 小规模端到端验证：构造迷你 payload，用安装器真实安装，再逐字节比对。
# 目的：在花几小时打全量包之前，先证明解包-校验-落盘这条链是对的。
set -u

ROOT=/c/Users/DR/Downloads/DSH/dsh-pack-rust
STAGE="$ROOT/_smoke/stage"
PAYLOAD="$ROOT/_smoke/payload"
TARGET="$ROOT/_smoke/target"
EXE="$ROOT/target/release/dsh-pack-installer.exe"

# Node 在 Windows 上不认 MSYS 路径，必须转成盘符形式
STAGE_WIN=$(cygpath -w "$STAGE")
PAYLOAD_WIN=$(cygpath -w "$PAYLOAD")
TARGET_WIN=$(cygpath -w "$TARGET")

rm -rf "$ROOT/_smoke"
mkdir -p "$STAGE/profiles/desktop/node_modules/demo/深/层/目录" "$PAYLOAD" "$TARGET"

echo '{"name":"smoke"}' > "$STAGE/profiles/desktop/package.json"
printf 'hello world\n' > "$STAGE/profiles/desktop/node_modules/demo/index.js"
printf '中文内容测试\n' > "$STAGE/profiles/desktop/node_modules/demo/深/层/目录/文件.txt"
printf 'x' > "$STAGE/profiles/desktop/empty-ish.txt"
# 造一个跨分卷边界的块，用固定内容避免依赖 /dev/urandom
yes 'DSH-SMOKE-PAYLOAD-BLOCK' 2>/dev/null | head -c 300000 > "$STAGE/profiles/desktop/blob.bin"

echo "=== 1. 生成清单 ==="
cd "$ROOT"
DSH_HOME="$STAGE_WIN" node tools/make-manifest.mjs "$PAYLOAD/manifest.json" 2>&1 | tail -3

echo
echo "=== 2. 打成 tar 并按分卷切开，模拟真实分卷包 ==="
tar -C "$STAGE" -cf "$PAYLOAD/payload.tar" .
ls -la "$PAYLOAD/payload.tar" | awk '{printf "tar size: %d bytes\n", $5}'
# 切成 64KB 一卷，强制产生多卷，验证拼接逻辑
split -b 64k -d -a 3 "$PAYLOAD/payload.tar" "$PAYLOAD/part."
rm -f "$PAYLOAD/payload.tar"
for f in "$PAYLOAD"/part.*; do
  num=$(basename "$f" | sed 's/^part\.//')
  n=$((10#$num + 1))
  mv "$f" "$(printf '%s/payload.tar.%03d' "$PAYLOAD" "$n")"
done
echo "分卷数量: $(ls "$PAYLOAD"/payload.tar.* | wc -l)"
ls "$PAYLOAD"/payload.tar.* | head -3

echo
echo "=== 3. 执行安装 ==="
"$EXE" --silent --target "$TARGET_WIN" --payload "$PAYLOAD_WIN" 2>&1
RC=$?
echo "installer exit code: $RC"

echo
echo "=== 4. 逐字节比对源与落盘 ==="
FAIL=0
while IFS= read -r rel; do
  a="$STAGE/$rel"
  b="$TARGET/$rel"
  if [ ! -f "$b" ]; then
    echo "MISSING $rel"
    FAIL=$((FAIL+1))
    continue
  fi
  ha=$(sha256sum "$a" | cut -d' ' -f1)
  hb=$(sha256sum "$b" | cut -d' ' -f1)
  if [ "$ha" != "$hb" ]; then
    echo "HASH MISMATCH $rel"
    FAIL=$((FAIL+1))
  fi
done < <(cd "$STAGE" && find . -type f | sed 's|^\./||')

echo
echo "=== 5. 清单外文件不得落盘 ==="
EXTRA=$(cd "$TARGET" && find . -type f | sed 's|^\./||' | grep -v -f <(cd "$STAGE" && find . -type f | sed 's|^\./||') | head -5)
if [ -n "$EXTRA" ]; then
  echo "EXTRA FILES: $EXTRA"
  FAIL=$((FAIL+1))
else
  echo "no extra files"
fi

echo
if [ "$FAIL" -eq 0 ] && [ "$RC" -eq 0 ]; then
  echo "SMOKE_RESULT: PASS"
  exit 0
else
  echo "SMOKE_RESULT: FAIL failures=$FAIL rc=$RC"
  exit 1
fi
