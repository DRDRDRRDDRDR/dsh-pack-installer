#!/bin/bash
# 小样本验证 7-Zip tar 输出链路：用少量文件确认路径与内容都正确。
set -u
ROOT=/c/Users/DR/Downloads/DSH/dsh-pack-rust
T="$ROOT/_probe7z"
SEVENZ='/c/Program Files/7-Zip/7z.exe'

rm -rf "$T"; mkdir -p "$T/source/sub/深层" "$T/out"
echo 'aaa' > "$T/source/a.txt"
echo '中文内容' > "$T/source/sub/深层/b.txt"
printf 'bin' > "$T/source/c.bin"

cd "$T/source" || exit 1
printf 'a.txt\nsub/深层/b.txt\nc.bin\n' > "$T/out/list.txt"

T_WIN=$(cygpath -w "$T")
"$SEVENZ" a -ttar -so -an -spf2 -scsUTF-8 -i@"$T_WIN\\out\\list.txt" dummy.tar \
  2>"$T/out/7z.err" > "$T/out/payload.tar"

echo "=== 7z stderr ==="; cat "$T/out/7z.err" | head -5
echo "=== tar size ==="; stat -c%s "$T/out/payload.tar"
echo "=== tar 内容 ==="; tar -tf "$T/out/payload.tar" 2>&1 | head -10
echo "=== 解压验证 ==="
mkdir -p "$T/verify"; tar -xf "$T/out/payload.tar" -C "$T/verify" 2>&1 | head -3
find "$T/verify" -type f | head -5
echo "=== 内容比对 ==="
cat "$T/verify/sub/深层/b.txt" 2>/dev/null || echo "MISSING deep file"
