#!/usr/bin/env node
/**
 * 把一个文件按固定大小切分成 payload.tar.001 起的分卷，并输出逐卷 SHA256。
 */
import { createReadStream, createWriteStream, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'

const src = process.argv[2]
const outDir = process.argv[3]
const volumeMB = Number(process.argv[4] || 2000)
const VOL = volumeMB * 1024 * 1024

mkdirSync(outDir, { recursive: true })

const total = statSync(src).size
console.error(`split source=${src} bytes=${total} volume=${VOL}`)

const rs = createReadStream(src, { highWaterMark: 8 << 20 })

let index = 0
let written = 0
let out = null
let hash = null
const volumes = []

function open() {
  index++
  const name = `payload.tar.${String(index).padStart(3, '0')}`
  out = createWriteStream(join(outDir, name))
  hash = createHash('sha256')
  written = 0
  volumes.push({ name, bytes: 0 })
}

function close() {
  return new Promise((res) => {
    if (!out) return res()
    out.end(() => {
      const v = volumes[volumes.length - 1]
      v.bytes = written
      v.sha256 = hash.digest('hex')
      res()
    })
  })
}

function write(buf) {
  return new Promise((res, rej) => out.write(buf, (e) => (e ? rej(e) : res())))
}

async function main() {
  open()
  for await (const chunk of rs) {
    let off = 0
    while (off < chunk.length) {
      const room = VOL - written
      const take = Math.min(room, chunk.length - off)
      const part = chunk.subarray(off, off + take)
      await write(part)
      hash.update(part)
      written += take
      off += take
      if (written >= VOL) {
        await close()
        open()
      }
    }
  }
  await close()

  writeFileSync(
    join(outDir, 'volumes.json'),
    JSON.stringify({ schemaVersion: 1, totalBytes: total, volumes }, null, 2)
  )
  writeFileSync(
    join(outDir, 'payload.sha256'),
    volumes.map((v) => `${v.sha256}  ${v.name}`).join('\n') + '\n'
  )
  console.error(`SPLIT_DONE volumes=${volumes.length}`)
  for (const v of volumes) console.error(`  ${v.name} ${v.bytes} ${v.sha256}`)
}

main().catch((e) => {
  console.error('SPLIT_FAIL', e?.stack || e)
  process.exit(1)
})
