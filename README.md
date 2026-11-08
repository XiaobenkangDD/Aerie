# 影巢（Aerie）

本地优先的桌面图片与素材库。原文件留在原来的文件夹里，影巢只建索引。显示名是「影巢」，仓库和包名是 `aerie`，库文件夹后缀是 `.aerie`。

当前安装包只打 macOS。窗口、资料库、索引，以及 JPG、PNG、WebP 这类常见图片不依赖系统。设计稿、PDF、视频、字体的预览走 macOS QuickLook，画面文字识别走 macOS Vision，其它系统上这两块会跳过。

## 环境

- Node.js 22
- macOS（完整功能，含 QuickLook 和 Vision）
- 画面文字识别需要本机能运行 `swift`（Xcode 命令行工具）

`better-sqlite3` 必须按 Electron 的 ABI 编译。`npm install` 会自动跑 `electron-rebuild`。换过 Electron 版本后如果数据库打不开，再执行一次 `npm run rebuild`。

## 常用命令

```bash
npm install
npm run dev          # 开发。改界面会热更新
npm run typecheck    # 主进程 + 界面
npm run test:features
npm run build
npm run dist         # 未签名的 macOS 目录包，输出在 release/
```

| 命令 | 做什么 |
|---|---|
| `npm run dev` | 先跑 `scripts/name-dev-app.mjs`，再启动 electron-vite |
| `npm run typecheck:node` / `typecheck:web` | 只查主进程或只查界面 |
| `npm run test:features` | 临时库上的功能测试，不打开窗口，不碰用户的照片 |
| `npm run test:lru` | 缩略图缓存淘汰 |
| `npm run verify -- /path/to/photos` | 用指定目录走一遍真实导入。不写路径时会去扫脚本里的默认照片目录 |
| `npm run dist:dmg` | 未签名 dmg |

开发时改 `src/renderer` 保存即可。改 `src/main`、`src/preload` 或原生模块后，要停掉再重新 `npm run dev`，热更新不会带上主进程。

`scripts/name-dev-app.mjs` 只在 macOS 上跑。它把开发用的 `Electron.app` 改名为 `影巢.app`，让程序坞显示「影巢」。这个改动在 `node_modules` 里，不要提交。

## 目录

```
src/shared/types.ts     IPC 名字、数据结构、window.aerie 的类型。改接口从这里开始
src/preload/index.ts    渲染进程唯一能调用的接口
src/main/index.ts       窗口、协议、生命周期
src/main/menu.ts        中文应用菜单
src/main/ipc/routes.ts  IPC 实现
src/main/db/schema.ts   新库的建表语句
src/main/db/index.ts    打开数据库、schema 版本、老库迁移
src/main/library/       开库、查询、修改、撤销、监视文件夹
src/main/importer/      扫描和导入
src/main/thumbs/        缩略图生成和缓存
src/main/analyze/       指纹、主色、拍摄时间、OCR
src/renderer/src/       界面。main.tsx 是主窗口，overlays.tsx 是大图和对话框
extensions/aerie-chrome 本机浏览器收藏扩展
test/features.ts        功能测试
```

渲染进程开了 `contextIsolation` 和 `sandbox`，不能 `require`，也不能读任意文件。缩略图用 `aerie-thumb://`，原图用 `aerie-file://`。

## 改一处功能时要动哪里

加一个界面能调用的能力：

1. `src/shared/types.ts` 里加上 IPC 名字和 `AerieApi` 方法
2. `src/preload/index.ts` 用 `ipcRenderer.invoke` 接出去
3. `src/main/ipc/routes.ts` 里实现

改表结构见下一节。不要在界面里直接写 SQL。

## 数据库迁移

当前 `SCHEMA_VERSION` 是 6，定义在 `src/main/db/index.ts`。

老库打开时会先执行 `SCHEMA_SQL`。那里的 `CREATE TABLE IF NOT EXISTS` 不会给已经存在的表补新列。所以：

1. 把 `SCHEMA_VERSION` 加 1
2. 新库用的列写进 `schema.ts` 的 `CREATE TABLE`
3. 另写一个 `ensureV*`：先 `ALTER TABLE` 补列，再创建用到这列的索引
4. 在 `migrate()` 里于读版本号之后调用它

索引如果写在 `SCHEMA_SQL` 里、又用了新列，老库会在 `ALTER` 之前失败。

## 库文件夹

```
<名字>.aerie/
├── library.json          库 id、名称、reference 或 copy
├── aerie.db              SQLite，WAL
├── aerie.db-wal
├── thumbs/{sm,md,lg}/    256 / 512 / 1280 的 webp，删了会按需重建
└── files/                只有「复制库」才有，按 id 前两位分子目录
```

引用库不搬动原文件。清空回收站只删索引，不删磁盘上的原文件。

开发时的最近打开记录在 `~/Library/Application Support/Aerie/`。显示名改成影巢之后，这个目录名仍是 Aerie，避免把已经记下的库弄丢。

## 平台差异

| 能力 | macOS | 其它系统 |
|---|---|---|
| 库、搜索、文件夹、标签、常见图片缩略图 | 有 | 代码能跑，没有现成安装包 |
| PSD、AI、PDF、视频、字体预览 | QuickLook | 跳过 |
| 画面文字识别 | Vision | 跳过，侧栏会说明原因 |
| 程序坞名称 | `name-dev-app.mjs` 改成影巢 | 不跑这段脚本 |

## 技术栈

Electron 35、React 19、TypeScript 5.7、Vite 6 / electron-vite、better-sqlite3、sharp。网格是自己写的虚拟滚动。

## 许可

个人学习和自用免费，禁止商用。全文在 `LICENSE`。项目依赖的第三方库仍使用它们各自的许可。
