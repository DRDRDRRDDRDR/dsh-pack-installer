#!/usr/bin/env node
/**
 * 从 stdin 读字节流，按 N MB 切分卷写入目录。
 * 这样打包不必先落一整份 tar，磁盘峰值等于产物本身。
 */
import { createWriteStream, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const outDir = process.argv[2]
const volumeMB = Number(process.argv[3] || 2000)
const VOLUME_BYTES = volumeMB * 1024 * 1024

mkdirSync(outDir, { recursive: true })

let index = 1
let written = 0
let stream = null
let hash = null
const volumes = []

function open() {
  const name = `payload.tar.${String(index).padStart(3, '0')}`
  stream = createWriteStream(join(outDir, name))
  hash = createHash('sha256')
  volumes.push({ name, bytes: 0 })
  written = 0
}

function close() {
  return new Promise((res) => {
    if (!stream) return res()
    stream.end(() => {
      const v = volumes[volumes.length - 1]
      v.bytes = written
      v.sha256 = hash.digest('hex')
      res()
    })
  })
}

function write(buf) {
  return new Promise((res, rej) => {
    stream.write(buf, (e) => (e ? rej(e) : res()))
  })
}

async function main() {
  open()
  let total = 0
  for await (const chunk of process.stdin) {
    let off = 0
    total += chunk.length
    while (off < chunk.length) {
      const room = VOLUME_BYTES - written
      const take = Math.min(room, chunk.length - off)
      const part = chunk.subarray(off, off + take)
      await write(part)
      hash.update(part)
      written += take
      off += take
      if (written >= VOLUME_BYTES) {
        await close()
        index++
        open()
      }
    }
  }
  await close()

  const shaText = volumes.map((v) => `${v.sha256}  ${v.name}`).join('\n') + '\n'
  writeFileSync(join(outDir, 'payload.sha256'), shaText)
  writeFileSync(
    join(outDir, 'volumes.json'),
    JSON.stringify({ schemaVersion: 1, totalBytes: total, volumes }, null, 2)
  )
  console.error(`SPLIT_DONE total=${total} volumes=${volumes.length}`)
  for (const v of volumes) console.error(`  ${v.name} ${v.bytes}`)
}

main().catch((e) => {
  console.error('SPLIT_FAIL', e?.stack || e)
  process.exit(1)
})
