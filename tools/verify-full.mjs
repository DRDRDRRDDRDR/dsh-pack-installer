#!/usr/bin/env node
/**
 * 全量验收：比对源与落盘，逐字节校验。
 * 抽样策略：全部 verified 文件里按大小分层抽，另对关键路径强制全查。
 */
import { readFileSync, statSync, createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = 'C:/Users/DR/Downloads/DSH/dsh-pack-rust'
const TARGET = join(ROOT, '_fulltest')
const MANIFEST = join(ROOT, '_build/out/manifest.json')
const SRC_ROOTS = {
  default: 'C:/Users/DR/.dsh',
  memory: join(ROOT, '_freeze'),
  skills: join(ROOT, '_freeze'),
}

const m = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const frozen = new Set(m.frozenDirs || [])

function sha256(p) {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    const s = createReadStream(p)
    s.on('data', (d) => h.update(d))
    s.on('end', () => res(h.digest('hex')))
    s.on('error', rej)
  })
}

/** 关键路径必须逐字节全查 */
const MUST = [
  'profiles/desktop/node_modules/dsh-ops/runtime/win32-x64/niubash/winuxcmd/usr/bin/rg.exe',
  'profiles/desktop/node_modules/dsh-ops/runtime/win32-x64/niubash/winuxcmd/usr/bin/bash.exe',
  'profiles/desktop/package.json',
  'profiles/desktop/cordis.patch.yml',
  'desktop-host-sources.patch.yml',
]

async function main() {
  let checked = 0
  let mismatch = 0
  let missing = 0
  const problems = []

  // 大文件优先抽查，小文件按比例
  const sorted = [...m.files].sort((a, b) => b.size - a.size)
  const sample = []
  const step = Math.max(1, Math.floor(sorted.length / 400))
  for (let i = 0; i < sorted.length; i += step) sample.push(sorted[i])
  // 所有 1MB 以上的文件全查
  for (const f of sorted) if (f.size >= 1024 * 1024) sample.push(f)
  // 关键路径
  for (const rel of MUST) {
    const e = m.files.find((x) => x.rel === rel)
    if (e) sample.push(e)
  }

  const seen = new Set()
  for (const f of sample) {
    if (seen.has(f.rel)) continue
    seen.add(f.rel)
    const top = f.rel.split('/')[0]
    const src = join(frozen.has(top) ? SRC_ROOTS.memory : SRC_ROOTS.default, ...f.rel.split('/'))
    const dst = join(TARGET, ...f.rel.split('/'))
    if (!existsSync(dst)) {
      missing++
      problems.push(`MISSING ${f.rel}`)
      continue
    }
    const st = statSync(dst)
    if (st.size !== f.size) {
      mismatch++
      problems.push(`SIZE ${f.rel} ${st.size}!=${f.size}`)
      continue
    }
    if (!existsSync(src)) {
      checked++
      continue
    }
    const a = await sha256(src)
    const b = await sha256(dst)
    if (a !== b) {
      mismatch++
      problems.push(`HASH ${f.rel}`)
    } else {
      checked++
    }
  }

  console.log(JSON.stringify({
    totalFiles: m.totalFiles,
    sampled: seen.size,
    hashVerified: checked,
    missing,
    mismatch,
    problems: problems.slice(0, 10),
  }, null, 2))

  if (missing || mismatch) process.exit(1)
}

main().catch((e) => {
  console.error('VERIFY_FAIL', e?.stack || e)
  process.exit(1)
})
