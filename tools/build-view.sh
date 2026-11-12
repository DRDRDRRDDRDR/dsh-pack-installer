#!/bin/bash
# 验证：把快照目录整个替换进一个临时视图，让 7-Zip 只从一个根读取。
# 做法是硬链接树：其余目录直接硬链接指回 DSH Home，memory 与 skills 指向冻结快照。
set -u
ROOT=/c/Users/DR/Downloads/DSH/dsh-pack-rust
VIEW="$ROOT/_view"
SNAP="$ROOT/_freeze"
H='/c/Users/DR/.dsh'

rm -rf "$VIEW"; mkdir -p "$VIEW"

echo "=== 构建视图，用硬链接不占空间 ==="
node - "$H" "$SNAP" "$VIEW" "$ROOT/_build/out/manifest.json" <<'NODE'
const fs = require('fs')
const path = require('path')
const [home, snap, view, manifestPath] = process.argv.slice(2).map((p) => p.replace(/\\/g, '/'))
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const frozen = new Set(m.frozenDirs || [])
let link = 0, copy = 0, fail = 0
for (const f of m.files) {
  const top = f.rel.split('/')[0]
  const root = frozen.has(top) ? snap : home
  const src = path.join(root, ...f.rel.split('/'))
  const dst = path.join(view, ...f.rel.split('/'))
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  try {
    const st = fs.statSync(src)
    if (st.size !== f.size) { console.error(`SIZE ${f.rel} ${st.size}!=${f.size}`); fail++; continue }
    try { fs.linkSync(src, dst); link++ } catch { fs.copyFileSync(src, dst); copy++ }
  } catch (e) { console.error(`ERR ${f.rel} ${e.code}`); fail++ }
}
console.error(`view hardlink=${link} copy=${copy} fail=${fail}`)
NODE

echo "=== 视图总计 ==="
du -sh "$VIEW" 2>/dev/null
df -h /c | tail -1
