#!/bin/bash
# 全量打包最终版：每一步都落盘并可独立校验，避免管道静默丢数据。
#
# 实测踩到的四个坑，都在这里避开：
# 1. 系统 tar 是 bsdtar 3.8.4，读 -T 列表时对 UTF-8 路径静默跳过，13 万文件只打进 2.6GB。
#    改用 7-Zip 生成 tar，实测 6.83GB 全覆盖。
# 2. memory 与 skills 在 DSH 运行时被持续写入，直接打包会让清单与实际错位。
#    先冻结成快照，清单与打包都基于快照。
# 3. dsh-ops 的 winuxcmd 运行时正被当前 shell 占用，复制与硬链接都报 EPERM。
#    用 7-Zip 从源目录按绝对路径单独打出补丁 tar。
# 4. 主 tar 与补丁 tar 需要合成一个连续归档，必须去掉中间结束块，
#    且 6.6GB 数据不能整段进内存，所以用流式 strip，再落成完整 tar 文件后切分。
set -u

ROOT=/c/Users/DR/Downloads/DSH/dsh-pack-rust
OUT="$ROOT/_build/out"
SNAP="$ROOT/_freeze"
VIEW="$ROOT/_view"
FULL="$ROOT/_build/full.tar"
SEVENZ='/c/Program Files/7-Zip/7z.exe'

rm -rf "$ROOT/_build" "$SNAP" 2>/dev/null || true
for i in 1 2 3; do rm -rf "$VIEW" 2>/dev/null && break; sleep 1; done
mkdir -p "$OUT" "$VIEW"
OUT_WIN=$(cygpath -w "$OUT")
SNAP_WIN=$(cygpath -w "$SNAP")

echo "=== 0. 冻结活性目录 ==="
node "$ROOT/tools/freeze.mjs" "$ROOT" 2>&1 | tail -4

echo
echo "=== 1. 生成清单 ==="
FREEZE_DIR="$SNAP_WIN" DSH_HOME='C:\Users\DR\.dsh' \
  node "$ROOT/tools/make-manifest-frozen.mjs" "$OUT/manifest.json" 2>&1 | tail -3

echo
echo "=== 2. 构建视图 ==="
node - "/c/Users/DR/.dsh" "$SNAP" "$VIEW" "$OUT/manifest.json" <<'NODE'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const [home, snap, view, manifestPath] = process.argv.slice(2).map((p) => p.replace(/\\/g, '/'))
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const frozen = new Set(m.frozenDirs || [])
let link = 0, copy = 0, fail = 0
const failedRels = []
for (const f of m.files) {
  const top = f.rel.split('/')[0]
  const root = frozen.has(top) ? snap : home
  const src = path.join(root, ...f.rel.split('/'))
  const dst = path.join(view, ...f.rel.split('/'))
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  try {
    const st = fs.statSync(src)
    if (st.size !== f.size) { console.error(`SIZE ${f.rel}`); fail++; continue }
    try { fs.linkSync(src, dst); link++ }
    catch {
      try { fs.copyFileSync(src, dst); copy++ }
      catch { console.error(`ERR ${f.rel} EPERM`); failedRels.push({ rel: f.rel, root }); fail++ }
    }
  } catch (e) { console.error(`ERR ${f.rel} ${e.code}`); fail++ }
}
console.error(`view hardlink=${link} copy=${copy} fail=${fail}`)
fs.writeFileSync(path.join(path.dirname(manifestPath), 'failed.json'), JSON.stringify(failedRels, null, 2))
NODE

echo
echo "=== 3. 生成文件列表 ==="
node - "$OUT/manifest.json" "$OUT/filelist.txt" <<'NODE'
const fs = require('fs')
const [manifestPath, outPath] = process.argv.slice(2)
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
fs.writeFileSync(outPath, m.files.map((f) => f.rel).join('\n') + '\n', 'utf8')
console.error(`filelist=${m.files.length}`)
NODE

echo
echo "=== 4. 主 tar 落盘 ==="
cd "$VIEW" || exit 1
"$SEVENZ" a -ttar -so -an -spf2 -scsUTF-8 -i@"$(cygpath -w "$OUT")\\filelist.txt" dummy.tar \
  > "$FULL" 2>"$OUT/7z.err"
echo "full.tar bytes=$(stat -c%s "$FULL")"
echo "7z err 行数=$(wc -l < "$OUT/7z.err")"

echo
echo "=== 5. 补打被占用文件并追加 ==="
if [ -f "$OUT/failed.json" ]; then
  FAILED=$(node -e "const f=require(process.argv[1]);process.stdout.write(String(f.length))" "$OUT/failed.json")
else
  FAILED=0
fi
echo "待补: ${FAILED:-0}"
if [ "${FAILED:-0}" -gt 0 ]; then
  node "$ROOT/tools/patch-tar.mjs" 2>&1 | tail -2
  if [ -f "$OUT/patch.tar" ]; then
    node "$ROOT/tools/merge-tar.mjs" "$FULL" "$OUT/patch.tar"
  fi
fi
echo "合并后 full.tar bytes=$(stat -c%s "$FULL")"

echo
echo "=== 6. 切分卷 ==="
rm -f "$OUT"/payload.tar.0* 2>/dev/null
node "$ROOT/tools/split-file.mjs" "$FULL" "$OUT_WIN" 2000

echo
echo "=== 7. 收尾 ==="
rm -f "$FULL"
cp "$OUT/manifest.json" "$OUT/manifest.json"
ls -la "$OUT"/payload.tar.* 2>/dev/null
echo "PACK_DONE"
