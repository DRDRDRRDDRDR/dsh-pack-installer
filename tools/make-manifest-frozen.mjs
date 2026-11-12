#!/usr/bin/env node
/**
 * 基于冻结快照生成打包清单。
 *
 * 与 make-manifest.mjs 的区别：
 * memory 与 skills 改为从 _freeze 快照读取，其余目录仍读真实 DSH Home。
 * 这样清单描述的字节与后续 tar 打包的字节来自同一份冻结内容，
 * 不会因为后台写入导致清单与实际不符。
 */
import { createHash } from 'node:crypto'
import { readdirSync, statSync, createReadStream, writeFileSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || 'C:/Users/DR/.dsh'
const FREEZE = process.env.FREEZE_DIR || 'C:/Users/DR/Downloads/DSH/dsh-pack-rust/_freeze'
const OUT = process.argv[2] || 'manifest.json'

// 冻结目录必须真实存在且非空，否则会静默漏掉知识库，
// 而知识库是需求明确要求保留的内容，漏了就是交付不完整。
for (const must of ['memory', 'skills']) {
  const p = join(FREEZE, must)
  if (!existsSync(p)) {
    console.error(`FATAL 冻结快照缺少 ${must}: ${p}`)
    process.exit(2)
  }
  const n = countFiles(p)
  if (n === 0) {
    console.error(`FATAL 冻结快照中 ${must} 为空: ${p}`)
    process.exit(2)
  }
  console.error(`frozen ${must}: ${n} files`)
}

function countFiles(dir) {
  let n = 0
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += countFiles(join(dir, e.name))
      else if (e.isFile()) n++
    }
  } catch {
    return 0
  }
  return n
}

const DENY_TOP = new Set([
  '.credentials.yaml', '.credentials.yaml.pre-merge-1790747763019.bak', '.anonymous-user-id',
  'sessions', 'attachments', 'cache', 'storages', 'logs', 'jet-hub', 'im', 'dsh-market',
  'integrations', 'redteam', 'recovery', 'restart-resume', 'subagent-gc-backup',
  'aik_auto_memory_use', 'infinite-gen-4', 'certs', 'guardian', 'dsh-config-manager',
  'dsh-runtimes', 'remote-web-ui-registry', 'skills-management', 'profiles-links-backup.json',
  'dsh-auto-memory-diagnose.log', 'dsh-auto-memory-pre-diagnose.log', 'plugin-upgrade-all.log',
  'helmd-stream-intercept.log', 'dsh-restart.log', 'dsh-install-022.log', 'restart-detached.log',
  'ops-spill-ledger.jsonl', 'hosts.bak-before-github-direct-20261021-031220',
])

// 冻结目录：从快照读
const FROM_FREEZE = new Set(['memory', 'skills'])

const INCLUDE_TOP = [
  'profiles/desktop', 'plugins', 'memory', 'skills', 'python-engine', 'models',
  'desktop-host-plugins.json', 'desktop-host-sources.patch.yml', 'dsh-auto-memory.json',
  'auto-continue-429.json', 'dream-skin.json', 'skills-market-sync.json',
  'remote-web-ui-relay-bridge.json',
]

const DENY_ANY = [
  /node_modules\/\.cache\//, /\.bak-before-/, /\.bak$/, /\.bak-\d{8}/, /\.generations\//,
  /\.plugin-manager\//, /\.dsh-market\//, /\.local-tarballs\//, /\.codearts-backup-/,
  /\/\.git\//, /\.map$/, /\.tmp-\d+-/,
]

function denied(relPath) {
  const parts = relPath.split(/[\\/]/)
  if (parts.length === 1 && DENY_TOP.has(parts[0])) return true
  if (DENY_TOP.has(parts[0]) && !INCLUDE_TOP.some((t) => t === parts[0] || t.startsWith(parts[0] + '/'))) {
    return true
  }
  return DENY_ANY.some((re) => re.test(relPath))
}

function* walk(dir, base) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    const full = join(dir, ent.name)
    const rel = relative(base, full).split(sep).join('/')
    if (denied(rel)) continue
    if (ent.isSymbolicLink()) continue
    if (ent.isDirectory()) yield* walk(full, base)
    else if (ent.isFile()) yield { rel, full }
  }
}

const files = []
let totalBytes = 0
const freezeRoot = FREEZE.replace(/\\/g, '/')

for (const top of INCLUDE_TOP) {
  const isFrozen = FROM_FREEZE.has(top)
  const abs = isFrozen ? join(FREEZE, top) : join(DSH_HOME, top)
  if (!existsSync(abs)) { console.error(`[skip] missing ${top}`); continue }
  const st = statSync(abs)
  if (st.isDirectory()) {
    for (const item of walk(abs, isFrozen ? FREEZE : DSH_HOME)) {
      const size = statSync(item.full).size
      totalBytes += size
      files.push({ rel: item.rel, size })
    }
  } else {
    totalBytes += st.size
    files.push({ rel: top, size: st.size })
  }
}

let violations = 0
for (const f of files) if (denied(f.rel)) { console.error(`[DENY] ${f.rel}`); violations++ }
if (violations) { console.error(`ABORT ${violations}`); process.exit(1) }

// 知识库必须进清单，这是需求的硬性要求，缺失即失败
const counts = {}
for (const f of files) {
  const t = f.rel.split('/')[0]
  counts[t] = (counts[t] || 0) + 1
}
for (const must of ['memory', 'skills']) {
  if (!counts[must]) {
    console.error(`FATAL 清单中缺少 ${must}`)
    process.exit(3)
  }
}
console.error(`top-level: ${JSON.stringify(counts)}`)

writeFileSync(OUT, JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  dshHome: DSH_HOME,
  freezeRoot,
  frozenDirs: [...FROM_FREEZE],
  totalFiles: files.length,
  totalBytes,
  includeTop: INCLUDE_TOP,
  files,
}, null, 2))

console.log(`OK files=${files.length} bytes=${totalBytes}`)
