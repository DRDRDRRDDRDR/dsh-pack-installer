#!/bin/bash
# 脱离式启动全量打包：本脚本自己 fork 出后台进程后立即返回，
# 这样即使调用方会话中断，打包进程仍继续跑完。
set -u
ROOT=/c/Users/DR/Downloads/DSH/dsh-pack-rust
cd "$ROOT" || exit 1
rm -f _pack.log _pack.done
setsid bash tools/pack-full.sh > _pack.log 2>&1 < /dev/null &
echo "launcher_pid=$!"
echo "log=$ROOT/_pack.log"
