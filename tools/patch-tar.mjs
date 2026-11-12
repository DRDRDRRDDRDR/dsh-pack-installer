#!/usr/bin/env node
/**
 * 生成补丁 tar：把这批被独占文件从源目录用 7-Zip 打包输出。
 * 用绝对路径列表，避免工作目录相对路径解析问题。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = 'C:/Users/DR/Downloads/DSH/dsh-pack-rust'
const OUT = `${ROOT}/_build/out`
const SEVENZ = 'C:/Program Files/7-Zip/7z.exe'

const failed = JSON.parse(readFileSync(`${OUT}/failed.json`, 'utf8'))
console.error(`补打 ${failed.length} 个文件`)

// 7-Zip 的 -spf2 要求列表里给完整盘符路径
const lines = failed.map(({ rel, root }) => `${root}/${rel}`.replace(/\//g, '\\'))
const listPath = `${OUT}/patch-list.txt`
writeFileSync(listPath, lines.join('\n') + '\n', 'utf8')

const stdout = execFileSync(
  SEVENZ,
  ['a', '-ttar', '-so', '-spf2', '-scsUTF-8', `-i@${listPath.replace(/\//g, '\\')}`, 'dummy.tar'],
  { maxBuffer: 2 * 1024 * 1024 * 1024 }
)
const tarPath = `${OUT}/patch.tar`
writeFileSync(tarPath, stdout)
console.error(`wrote patch.tar bytes=${stdout.length}`)
console.log(tarPath)
