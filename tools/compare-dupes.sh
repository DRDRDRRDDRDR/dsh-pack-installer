#!/bin/bash
# 比对两份 dsh-infinite-gen-5 是否同内容，决定能否去重
A=/c/Users/DR/.dsh/plugins/dsh-infinite-gen-5
B=/c/Users/DR/.dsh/profiles/desktop/node_modules/dsh-infinite-gen-5

echo "=== A: plugins ==="
find "$A" -type f 2>/dev/null | wc -l
du -sb "$A" 2>/dev/null | cut -f1

echo "=== B: profile node_modules ==="
find "$B" -type f 2>/dev/null | wc -l
du -sb "$B" 2>/dev/null | cut -f1

echo "=== 只在 B 存在的顶层项 ==="
comm -13 <(ls -A "$A" 2>/dev/null | sort) <(ls -A "$B" 2>/dev/null | sort) | head -20

echo "=== 只在 A 存在的顶层项 ==="
comm -23 <(ls -A "$A" 2>/dev/null | sort) <(ls -A "$B" 2>/dev/null | sort) | head -20

echo "=== runtimes 体积对比 ==="
du -sb "$A/runtimes" 2>/dev/null | cut -f1
du -sb "$B/runtimes" 2>/dev/null | cut -f1

echo "=== 抽样文件大小对比 ==="
for f in package.json runtimes/manifest.json; do
  echo -n "$f A="; stat -c%s "$A/$f" 2>/dev/null || echo missing
  echo -n "$f B="; stat -c%s "$B/$f" 2>/dev/null || echo missing
done
