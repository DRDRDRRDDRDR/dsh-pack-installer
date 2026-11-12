#!/usr/bin/env node
/**
 * 把补打文件补进清单。
 *
 * 为什么需要：安装器只落清单内的文件，补丁 tar 里的 159 个文件如果不在清单，
 * 会被当作夹带内容跳过，目标机就缺 dsh-ops 的 shell 运行时，
 * 一调用工具就会崩。
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'C:/Users/DR/Downloads/DSH/dsh-pack-rust/_build/out'
const manifestPath = join(OUT, 'manifest.json')
const m = JSON.parse(readFileSync(manifestPath, 'utf8'))

let failed = []
try {
  failed = JSON.parse(readFileSync(join(OUT, 'failed.json'), 'utf8'))
} catch {
  console.error('无 failed.json，跳过')
  process.exit(0)
}

const have = new Set(m.files.map((f) => f.rel))
let added = 0
let bytes = 0
for (const { rel, root } of failed) {
  if (have.has(rel)) continue
  // 从源读取真实大小
  const src = join(root, ...rel.split('/'))
  const st = statSync(src)
  m.files.push({ rel, size: st.size })
  bytes += st.size
  added++
}

m.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
m.totalFiles = m.files.length
m.totalBytes += bytes
m.patchedFiles = added

writeFileSync(manifestPath, JSON.stringify(m, null, 2))
console.error(`补入清单 ${added} 个文件，${bytes} 字节，总计 ${m.totalFiles} 个`)
