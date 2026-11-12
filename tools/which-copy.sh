#!/bin/bash
# 判断 dsh-infinite-gen-5 的真实引用来源
set -u
P=/c/Users/DR/.dsh/profiles/desktop

echo "=== package.json 里的声明 ==="
grep -n 'infinite-gen' "$P/package.json"

echo
echo "=== node_modules 里的那一份是否为链接 ==="
node -e "
const fs=require('fs');
const p='C:/Users/DR/.dsh/profiles/desktop/node_modules/dsh-infinite-gen-5';
try{
  const s=fs.lstatSync(p);
  console.log('isSymlink=',s.isSymbolLink||s.isSymbolicLink(),'isDir=',s.isDirectory());
}catch(e){console.log('ERR',e.code)}
"

echo
echo "=== plugins 目录那一份的 package.json 版本 ==="
node -e "
const a=require('C:/Users/DR/.dsh/plugins/dsh-infinite-gen-5/package.json');
const b=require('C:/Users/DR/.dsh/profiles/desktop/node_modules/dsh-infinite-gen-5/package.json');
console.log('plugins     name=',a.name,'version=',a.version);
console.log('node_modules name=',b.name,'version=',b.version);
console.log('same version:', a.version===b.version);
"

echo
echo "=== 两份的 runtimes 哈希抽样比对 ==="
for f in runtimes/manifest.json package.json; do
  A=$(sha256sum "/c/Users/DR/.dsh/plugins/dsh-infinite-gen-5/$f" 2>/dev/null | cut -d' ' -f1)
  B=$(sha256sum "$P/node_modules/dsh-infinite-gen-5/$f" 2>/dev/null | cut -d' ' -f1)
  if [ "$A" = "$B" ]; then echo "SAME  $f"; else echo "DIFF  $f"; fi
done
