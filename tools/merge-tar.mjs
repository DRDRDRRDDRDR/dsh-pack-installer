#!/usr/bin/env node
/**
 * 把补丁 tar 合并进主 tar，形成一个连续合法的归档。
 *
 * 要点：两段 tar 各自末尾都有两个 512 字节的零块结束标记，
 * 合并时必须去掉中间那份，只在最末补一次，否则读取会在第一个结束标记中断。
 */
import { openSync, readSync, writeSync, statSync, ftruncateSync, closeSync, renameSync } from 'node:fs'

const fullPath = process.argv[2]
const patchPath = process.argv[3]

/** 返回去掉末尾零块后的有效长度 */
function bodyLength(path) {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  const block = Buffer.alloc(512)
  let end = size
  for (let i = 0; i < 2 && end >= 512; i++) {
    readSync(fd, block, 0, 512, end - 512)
    let zero = true
    for (const b of block) {
      if (b !== 0) {
        zero = false
        break
      }
    }
    if (!zero) break
    end -= 512
  }
  closeSync(fd)
  return end
}

const fullBody = bodyLength(fullPath)
const patchBody = bodyLength(patchPath)

// 先截断主 tar 去掉其结束块，再把补丁体追加进去，最后补一次结束块
const fullFd = openSync(fullPath, 'r+')
ftruncateSync(fullFd, fullBody)
closeSync(fullFd)

const patchFd = openSync(patchPath, 'r')
const outFd = openSync(fullPath, 'a')
const buf = Buffer.alloc(8 << 20)
let left = patchBody
let pos = 0
while (left > 0) {
  const want = Math.min(buf.length, left)
  const n = readSync(patchFd, buf, 0, want, pos)
  if (n <= 0) break
  writeSync(outFd, buf, 0, n)
  pos += n
  left -= n
}
writeSync(outFd, Buffer.alloc(1024, 0))
closeSync(patchFd)
closeSync(outFd)

console.error(`merged fullBody=${fullBody} patchBody=${patchBody} final=${statSync(fullPath).size}`)
