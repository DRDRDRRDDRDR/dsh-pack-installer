#!/usr/bin/env node
/**
 * 直接从分卷读取并统计 tar 条目数，不落任何临时整包文件。
 * 目的：验证分卷里到底有多少文件，与清单 132550 条对齐。
 */
import { createReadStream, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const outDir = process.argv[2]
const files = readdirSync(outDir)
  .filter((f) => /^payload\.tar\.\d{3}$/.test(f))
  .sort()
console.error(`volumes: ${files.length}`)

// 把多个分卷按顺序串成一个可读流，逐块产出 Buffer
async function* parts() {
  for (const f of files) {
    const rs = createReadStream(join(outDir, f), { highWaterMark: 8 << 20 })
    for await (const chunk of rs) {
      yield chunk
    }
  }
}
const stream = Readable.from(parts())

/** 极简 tar 扫描：只读 512 字节头，跳过数据区，统计普通文件 */
async function main() {
  let buf = Buffer.alloc(0)
  let count = 0
  let totalSize = 0
  let done = false

  const need = async (n) => {
    while (buf.length < n) {
      const chunk = stream.read()
      if (chunk === null) {
        if (stream.readableEnded) return false
        await new Promise((r) => stream.once('readable', r).once('end', r))
        continue
      }
      buf = Buffer.concat([buf, chunk])
    }
    return true
  }

  const take = async (n) => {
    if (!(await need(n))) return null
    const out = buf.subarray(0, n)
    buf = buf.subarray(n)
    return out
  }

  const skip = async (n) => {
    let left = n
    while (left > 0) {
      if (buf.length === 0) {
        if (!(await need(1))) return false
      }
      const c = Math.min(left, buf.length)
      buf = buf.subarray(c)
      left -= c
    }
    return true
  }

  while (true) {
    const hdr = await take(512)
    if (!hdr) break
    // 全零块表示归档结束
    let allZero = true
    for (const b of hdr) {
      if (b !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) {
      done = true
      break
    }
    const name = hdr.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeOctal = hdr.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeOctal, 8) || 0
    const typeflag = String.fromCharCode(hdr[156] || 48)
    // 跳过 15 字节的 "ustar\0" 之后可能有 longname 扩展
    if (typeflag === 'L') {
      // GNU 长名块：数据区是真实文件名，读掉即可
      await skip(Math.ceil(size / 512) * 512)
      continue
    }
    if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      count++
      totalSize += size
    }
    await skip(Math.ceil(size / 512) * 512)
  }

  console.error(`TAR_SCAN files=${count} contentBytes=${totalSize} ended=${done}`)
  console.log(JSON.stringify({ files: count, contentBytes: totalSize, ended: done }))
}

main().catch((e) => {
  console.error('SCAN_FAIL', e?.stack || e)
  process.exit(1)
})
