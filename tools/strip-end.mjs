#!/usr/bin/env node
/**
 * 流式去掉 tar 流末尾的 1024 字节结束块，让多个 tar 能首尾相接。
 *
 * 必须流式：主包 6.6GB，整段缓冲会直接 OOM。
 * 做法是始终只保留最后 1024 字节不输出，流结束时判断这 1024 字节是否为
 * 全零结束块，是则丢弃，否则补发。
 */
const TAIL = 1024
let tail = Buffer.alloc(0)
let emitted = 0

process.stdin.on('data', (chunk) => {
  tail = tail.length ? Buffer.concat([tail, chunk]) : chunk
  if (tail.length > TAIL) {
    const cut = tail.length - TAIL
    process.stdout.write(tail.subarray(0, cut))
    emitted += cut
    tail = tail.subarray(cut)
  }
})

process.stdin.on('end', () => {
  // 判断尾部的 1024 字节是否全零
  let allZero = tail.length >= TAIL
  if (allZero) {
    for (const b of tail) {
      if (b !== 0) {
        allZero = false
        break
      }
    }
  }
  if (allZero) {
    // 丢弃结束块
  } else if (tail.length) {
    process.stdout.write(tail)
    emitted += tail.length
  }
  process.stderr.write(`strip-end emitted=${emitted} droppedZeroTail=${allZero}\n`)
})
