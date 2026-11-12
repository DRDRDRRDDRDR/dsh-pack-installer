#!/usr/bin/env node
/**
 * 单遍流式打包：直接按清单读源文件写 tar，边写边切 2GB 分卷。
 *
 * 为什么不用 staging 目录再 tar：
 * C 盘只剩约 20GB，staging 6.6GB 加 tar 6.6GB 加分卷 6.6GB 会爆盘。
 * 这里只产生分卷本身，峰值占用约等于产物大小。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createReadStream, statSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = process.argv[2] || 'C:/Users/DR/Downloads/DSH/dsh-pack-rust'
const DSH_HOME = process.argv[3] || 'C:/Users/DR/.dsh'
const VOLUME_BYTES = 2 * 1024 * 1024 * 1024

const OUT = join(ROOT, '_build', 'out')
rmSync(join(ROOT, '_build'), { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const manifest = JSON.parse(readFileSync(join(ROOT, '_build_manifest.json'), 'utf8'))
console.error(`manifest files=${manifest.totalFiles} bytes=${manifest.totalBytes}`)

let volumeIndex = 1
let volumeWritten = 0
let out = null
let tmpPath = null
const volumes = []

function openVolume() {
  const name = `payload.tar.${String(volumeIndex).padStart(3, '0')}`
  tmpPath = join(OUT, name)
  out = createWriteStream(tmpPath)
  volumeWritten = 0
  volumes.push({ name, size: 0 })
}

function closeVolume() {
  return new Promise((resolve) => {
    if (!out) return resolve()
    out.end(() => resolve())
  })
}

function writeChunk(buf) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e)
    out.once('error', onError)
    out.write(buf, () => {
      out.removeListener('error', onError)
      resolve()
    })
  })
}

/** 写 tar 头：POSIX ustar，文件名 <=100 字节否则用 prefix 拆分 */
function tarHeader(name, size, mode, mtimeSec) {
  const h = Buffer.alloc(512, 0)
  let nameBuf = Buffer.from(name, 'utf8')
  if (nameBuf.length > 100) {
    // 用 ustar prefix 拆到 155 + 100
    const parts = name.split('/')
    let prefix = ''
    let rest = name
    while (Buffer.byteLength(rest, 'utf8') > 100 && parts.length > 1) {
      parts.pop()
      prefix = parts.join('/')
      rest = name.slice(prefix.length + 1)
    }
    if (Buffer.byteLength(prefix, 'utf8') > 155 || Buffer.byteLength(rest, 'utf8') > 100) {
      throw new Error(`路径过长无法放入 tar 头: ${name}`)
    }
    h.write(prefix, 0, 155, 'utf8')
    nameBuf = Buffer.from(rest, 'utf8')
    h.write(nameBuf.toString('utf8'), 157, 100, 'utf8')
    h.write('ustar\x0000', 257, 8, 'binary')
  } else {
    h.write(nameBuf.toString('utf8'), 0, 100, 'utf8')
    h.write('ustar\x0000', 257, 8, 'binary')
  }
  h.write('0000644\x00', 100, 8, 'binary')
  h.write('0000000\x00', 108, 8, 'binary')
  h.write('0000000\x00', 116, 8, 'binary')
  h.write(size.toString(8).padStart(11, '0') + '\x00', 124, 12, 'binary')
  h.write(mtimeSec.toString(8).padStart(11, '0') + '\x00', 136, 12, 'binary')
  h.write('        ', 148, 8, 'binary')
  h.write('0', 156, 1, 'binary')
  // 校验和
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\x00 ', 148, 8, 'binary')
  return h
}

function padTo512(n) {
  const r = n % 512
  return r === 0 ? 0 : 512 - r
}

async function main() {
  openVolume()
  let files = 0

  for (const f of manifest.files) {
    const src = join(DSH_HOME, f.rel.split('/').join(sep))
    if (!existsSync(src)) {
      console.error(`MISSING_SOURCE ${f.rel}`)
      continue
    }
    const st = statSync(src)
    if (st.size !== f.size) {
      console.error(`SIZE_DRIFT ${f.rel} manifest=${f.size} disk=${st.size}`)
      continue
    }
    const name = f.rel
    const header = tarHeader(name, f.size, 0o644, Math.floor(st.mtimeMs / 1000))

    // 头可能跨卷，逐块写
    await writeWithSplit(header)
    // 内容
    await new Promise((resolve, reject) => {
      const rs = createReadStream(src)
      rs.on('error', reject)
      rs.on('data', async (chunk) => {
        rs.pause()
        try {
          await writeWithSplit(chunk)
          rs.resume()
        } catch (e) {
          rs.destroy()
          reject(e)
        }
      })
      rs.on('end', resolve)
    })
    const pad = padTo512(f.size)
    if (pad > 0) await writeWithSplit(Buffer.alloc(pad, 0))
    files++
    if (files % 2000 === 0) console.error(`progress files=${files}`)
  }

  // tar 结束标记：两个 512 空块
  await writeWithSplit(Buffer.alloc(1024, 0))
  await closeVolume()

  const sha = createHash('sha256')
  for (const v of volumes) {
    const p = join(OUT, v.name)
    v.size = statSync(p).size
    // 逐卷哈希
    await new Promise((resolve, reject) => {
      const rs = createReadStream(p)
      const h = createHash('sha256')
      rs.on('data', (d) => h.update(d))
      rs.on('end', () => {
        v.sha256 = h.digest('hex')
        resolve()
      })
      rs.on('error', reject)
    })
  }

  const shaText = volumes.map((v) => `${v.sha256}  ${v.name}`).join('\n') + '\n'
  writeFileSync(join(OUT, 'payload.sha256'), shaText)
  writeFileSync(
    join(OUT, 'volumes.json'),
    JSON.stringify({ schemaVersion: 1, files, volumes }, null, 2)
  )

  console.error(`PACK_DONE files=${files} volumes=${volumes.length}`)
  for (const v of volumes) {
    console.error(`  ${v.name} ${v.size} ${v.sha256}`)
  }
}

async function writeWithSplit(buf) {
  let offset = 0
  while (offset < buf.length) {
    const room = VOLUME_BYTES - volumeWritten
    const take = Math.min(room, buf.length - offset)
    await writeChunk(buf.subarray(offset, offset + take))
    volumeWritten += take
    offset += take
    if (volumeWritten >= VOLUME_BYTES) {
      await closeVolume()
      volumeIndex++
      openVolume()
    }
  }
}

main().catch((e) => {
  console.error('PACK_FAIL', e && e.stack ? e.stack : e)
  process.exit(1)
})
