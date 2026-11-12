#!/usr/bin/env node
/**
 * 打包前把活性目录冻结成快照。
 *
 * 关键容错，都是在 DSH 正在运行时实测踩到的：
 *  - memory 目录里有 *.lock 与正在写的 tmp 文件，复制到一半会消失，
 *    报 ENOENT 并中断整个冻结，导致 skills 还没开始复制就退出。
 *  - 因此逐文件复制，任何单个文件失败只记录并跳过，不中断整体。
 *  - 结束后对关键目录做数量断言，数量为零即失败，防止静默漏掉知识库。
 */
import { readdirSync, statSync, mkdirSync, copyFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const ROOT = process.argv[2] || 'C:/Users/DR/Downloads/DSH/dsh-pack-rust'
const DSH_HOME = process.argv[3] || 'C:/Users/DR/.dsh'
const SNAP = join(ROOT, '_freeze')
const FREEZE = ['memory', 'skills']

// 明确不冻结的临时与锁文件
const SKIP = [/\.lock$/, /\.tmp-\d+-/, /\.dshtmp$/, /~$/, /\.swp$/]

if (existsSync(SNAP)) {
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(SNAP, { recursive: true, force: true })
      break
    } catch (e) {
      console.error(`清理旧快照失败，重试 ${i + 1}: ${e.code}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  }
}
mkdirSync(SNAP, { recursive: true })

const stats = {}

for (const name of FREEZE) {
  const src = join(DSH_HOME, name)
  if (!existsSync(src)) {
    console.error(`FATAL 源目录不存在: ${src}`)
    process.exit(2)
  }
  const dst = join(SNAP, name)
  let copied = 0
  let skipped = 0
  let failed = 0
  let bytes = 0

  const walk = (d, rel) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch (e) {
      failed++
      return
    }
    for (const e of entries) {
      const s = join(d, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (SKIP.some((re) => re.test(e.name))) {
        skipped++
        continue
      }
      if (e.isDirectory()) {
        walk(s, r)
        continue
      }
      if (!e.isFile()) continue
      const t = join(dst, ...r.split('/'))
      try {
        mkdirSync(dirname(t), { recursive: true })
        copyFileSync(s, t)
        copied++
        bytes += statSync(t).size
      } catch (err) {
        // 活跃写入导致的瞬时消失属预期，跳过并计数
        failed++
      }
    }
  }

  walk(src, '')
  stats[name] = { copied, skipped, failed, bytes }
  console.error(`${name}: copied=${copied} skipped=${skipped} failed=${failed} bytes=${bytes}`)
  if (copied === 0) {
    console.error(`FATAL 冻结 ${name} 后为空`)
    process.exit(2)
  }
}

writeFileSync(join(SNAP, '_freeze.json'), JSON.stringify({ stats, at: new Date().toISOString() }, null, 2))
console.error(`FREEZE_DONE ${JSON.stringify(stats)}`)
console.log(JSON.stringify(stats))
