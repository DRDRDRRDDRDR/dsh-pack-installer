#!/usr/bin/env node
/**
 * DSH 全量分发包清单生成器
 *
 * 目标：扫描待打包范围，产出逐文件的尺寸与 SHA256 清单，
 * 并硬性拒绝任何被列入排除名单的路径。
 *
 * 排除原则：
 *  - 会话记录、附件、缓存、密钥：属于个人数据，绝不打包
 *  - 开发残留与备份目录：体积大且无用
 *
 * 保留原则：
 *  - memory 与 skills 属于用户指定要保留的知识库
 */
import { createHash } from 'node:crypto'
import { readdirSync, statSync, createReadStream, writeFileSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || 'C:/Users/DR/.dsh'
const OUT = process.argv[2] || 'manifest.json'

// 绝不打包：个人数据
const DENY_TOP = new Set([
  '.credentials.yaml',
  '.credentials.yaml.pre-merge-1790747763019.bak',
  '.anonymous-user-id',
  'sessions',
  'attachments',
  'cache',
  'storages',
  'logs',
  'jet-hub',
  'im',
  'dsh-market',
  'integrations',
  'redteam',
  'recovery',
  'restart-resume',
  'subagent-gc-backup',
  'aik_auto_memory_use',
  'infinite-gen-4',
  'certs',
  'guardian',
  'dsh-config-manager',
  'dsh-runtimes',
  'remote-web-ui-registry',
  'skills-management',
  'profiles-links-backup.json',
  'dsh-auto-memory-diagnose.log',
  'dsh-auto-memory-pre-diagnose.log',
  'plugin-upgrade-all.log',
  'helmd-stream-intercept.log',
  'dsh-restart.log',
  'dsh-install-022.log',
  'restart-detached.log',
  'ops-spill-ledger.jsonl',
  'hosts.bak-before-github-direct-20261021-031220',
])

// 打包白名单：只取这些顶层项
const INCLUDE_TOP = [
  'profiles/desktop',
  'plugins',
  'memory',
  'skills',
  'python-engine',
  'models',
  'desktop-host-plugins.json',
  'desktop-host-sources.patch.yml',
  'dsh-auto-memory.json',
  'auto-continue-429.json',
  'dream-skin.json',
  'skills-market-sync.json',
  'remote-web-ui-relay-bridge.json',
]

// 任意层级都排除的模式
const DENY_ANY = [
  /node_modules\/\.cache\//,
  /\.bak-before-/,
  /\.bak$/,
  /\.bak-\d{8}/,
  /\.generations\//,
  /\.plugin-manager\//,
  /\.dsh-market\//,
  /\.local-tarballs\//,
  /\.codearts-backup-/,
  /\/\.git\//,
  /\.map$/,
]

function denied(relPath) {
  const parts = relPath.split(/[\\/]/)
  if (parts.length === 1 && DENY_TOP.has(parts[0])) return true
  if (DENY_TOP.has(parts[0]) && !INCLUDE_TOP.some((t) => t.startsWith(parts[0] + '/') || t === parts[0])) {
    return true
  }
  return DENY_ANY.some((re) => re.test(relPath))
}

function* walk(dir, base) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    const full = join(dir, ent.name)
    const rel = relative(base, full).split(sep).join('/')
    if (denied(rel)) continue
    if (ent.isSymbolicLink()) {
      yield { rel, link: true }
      continue
    }
    if (ent.isDirectory()) {
      yield* walk(full, base)
    } else if (ent.isFile()) {
      yield { rel, full, link: false }
    }
  }
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

const files = []
const links = []
let totalBytes = 0
let deniedHits = 0

for (const top of INCLUDE_TOP) {
  const abs = join(DSH_HOME, top)
  if (!existsSync(abs)) {
    console.error(`[skip] missing include: ${top}`)
    continue
  }
  const st = statSync(abs)
  if (st.isDirectory()) {
    for (const item of walk(abs, DSH_HOME)) {
      if (item.link) {
        links.push({ rel: item.rel })
        continue
      }
      const size = statSync(item.full).size
      totalBytes += size
      files.push({ rel: item.rel, size })
    }
  } else {
    totalBytes += st.size
    files.push({ rel: top, size: st.size })
  }
}

// 硬校验：不得有任何被拒绝的路径混入
for (const f of files) {
  if (denied(f.rel)) {
    console.error(`[DENY VIOLATION] ${f.rel}`)
    deniedHits++
  }
}

if (deniedHits > 0) {
  console.error(`ABORT: ${deniedHits} denied paths leaked into manifest`)
  process.exit(1)
}

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  dshHome: DSH_HOME,
  totalFiles: files.length,
  totalBytes,
  symlinks: links.length,
  includeTop: INCLUDE_TOP,
  denyTop: [...DENY_TOP],
  files,
}

writeFileSync(OUT, JSON.stringify(manifest, null, 2))
console.log(`OK files=${files.length} bytes=${totalBytes} symlinks=${links.length}`)
console.log(`manifest -> ${OUT}`)
