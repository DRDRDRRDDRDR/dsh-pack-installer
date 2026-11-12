# DSH 全量分发包

把官方 DeepSeek Harness 本体与全部插件、配置、知识库一次性装到一台干净的 Windows 机器上。
装完之后不需要联网跑 `pnpm install`，不需要预装 Node、Python 或 7-Zip。

## 这个包解决什么问题

上一版分发包在别的机器上装不上，根因已经查实：它把 `~/.dsh/profiles/node_modules` 当成真实的依赖树来打包，
但实际上那 35 个顶层目录**全是空目录，零文件**。真正的宿主包 `@deepseek-ai/*` 由官方本体的
`app.asar` 内部提供，运行时的入口是
`resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`。
上一版还依赖 667 条指回 `DSH Desktop\resources\app\node_modules` 的 junction，那个路径在新版里已经不存在。

所以这一版的策略是：**只打包真正有字节的东西，不依赖任何链接，不在目标机做任何联网安装。**

## 包内容

| 部分 | 说明 |
| --- | --- |
| 官方本体安装程序 | 未做任何修改，官方签名原样 |
| `profiles/desktop` | 完整的实体依赖树，22 个第三方插件及其全部依赖 |
| `plugins` | 插件源目录 |
| `memory` 与 `skills` | 知识库，按需求保留 |
| `python-engine`、`models` | 随包的 Python 运行时与模型 |
| 顶层配置 | `desktop-host-plugins.json`、`desktop-host-sources.patch.yml` 等 |

## 明确不含的内容

`sessions`、`attachments`、`cache`、`storages`、`logs`、`jet-hub`、`im`、`.credentials.yaml`、`certs`。
清单生成器对上述路径设了硬性中止：只要有一条混进清单，整个打包立即失败退出，不会产出残缺包。

账号凭据一律不带，目标机首次启动请用你自己的账号登录。

## 安装

1. 双击 `dsh-pack-installer.exe`。
2. 确认两栏路径：安装包目录指向含 `payload.tar.001` 的文件夹，安装位置默认是 `%USERPROFILE%\.dsh`。
3. 点「开始安装」，等进度条走完。
4. 装完会立刻自检，缺任何文件都会报错并停下，不会留下半装状态。

命令行模式供自动化使用：

```
dsh-pack-installer.exe --silent --target D:\somewhere\.dsh --payload D:\pack
```

成功输出 `INSTALL_OK written=<n> skipped=<n> bytes=<n>`，退出码 0。
失败输出 `INSTALL_FAIL <原因>`，退出码非 0。

## 分卷

`payload.tar.001` 到 `payload.tar.004`，每卷上限 2 GB，合计约 6.83 GB。
安装器按序号顺序读取，序号不连续会直接拒绝，不会装出一个错位的树。
`payload.sha256` 是逐卷哈希，`volumes.json` 记录分卷清单与字节数。

## 已知边界

- 只支持 Windows x64。官方本体本身只有这个平台。
- 安装位置必须是绝对路径，且不能是盘根、`C:\Windows`、`Program Files`、`ProgramData`。
- 装机需要约 7 GB 空闲空间。
- `dsh-infinite-gen-5` 在源机上存了两份副本，包内只放一份，另一份由 profile 的依赖树自然引用。

## 自己重新打包

```
node tools/make-manifest.mjs _build_manifest.json     # 生成清单并做排除校验
bash tools/pack-full.sh                                # 打包切分卷
bash tools/smoke.sh                                    # 小样本冒烟
```

打包用 7-Zip 生成 tar 而不是系统 tar，原因见 `tools/pack-full.sh` 头部注释：
Windows 内置的 bsdtar 读文件列表时会对 UTF-8 路径逐条报错并静默跳过，实测 13 万个文件只能打进 2.6 GB。
