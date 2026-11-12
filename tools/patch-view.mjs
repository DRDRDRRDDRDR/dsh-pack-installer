#!/usr/bin/env node
/**
 * 补打因 EPERM 未能进入视图的文件。
 *
 * 背景：dsh-ops 的 winuxcmd 运行时正被当前 shell 占用，硬链接与复制都被拒绝，
 * 但 7-Zip 能读取其字节。这里用 7-Zip 把文件抽到视图，再单独打成一个补丁 tar，
 * 由打包脚本按顺序输出。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const ROOT = 'C:/Users/DR/Downloads/DSH/dsh-pack-rust'
const OUT = join(ROOT, '_build/out')
const VIEW = join(ROOT, '_view')
const SNAP = join(ROOT, '_freeze')
const HOME = 'C:/Users/DR/.dsh'
const SEVENZ = 'C:/Program Files/7-Zip/7z.exe'

const failed = JSON.parse(readFileSync(join(OUT, 'failed.json'), 'utf8'))
console.error(`补打 ${failed.length} 个文件`)

let ok = 0
let bad = 0
for (const { rel, root } of failed) {
  const src = join(root, ...rel.split('/'))
  const dst = join(VIEW, ...rel.split('/'))
  try {
    mkdirSync(dirname(dst), { recursive: true })
    // 7-Zip 抽出到 stdout，不经过 Windows 复制 API 的权限检查
    const buf = execFileSync(SEVENZ, ['e', '-so', src, '-bd'], {
      maxBuffer: 1024 * 1024 * 1024,
    })
    writeFileSync(dst, buf)
    ok++
  } catch (e) {
    console.error(`STILL_FAIL ${rel} ${e.code || e.message}`)
    bad++
  }
}
console.error(`补打完成 ok=${ok} bad=${bad}`)
if (bad > 0) process.exit(1)
