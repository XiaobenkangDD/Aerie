# 影巢 Yingchao (Aerie)

本地优先的桌面图片与素材库。原文件留在原来的文件夹里，影巢只建索引。显示名是「影巢」，仓库和包名是 `aerie`，库文件夹后缀是 `.aerie`。

A local-first desktop image and asset library. Original files stay in their folders; Yingchao only keeps an index. The display name is 影巢. The repository and package name are `aerie`. A library folder ends with `.aerie`.

当前安装包只打 macOS。窗口、资料库、索引，以及 JPG、PNG、WebP 这类常见图片不依赖系统。设计稿、PDF、视频、字体的预览走 macOS QuickLook，画面文字识别走 macOS Vision，其它系统上这两块会跳过。

The current installer is macOS only. The window, library, index, and thumbnails for everyday images such as JPG, PNG, and WebP do not depend on macOS. Previews for design files, PDFs, video, and fonts use macOS QuickLook. Text recognition uses macOS Vision. On other systems those two parts are skipped.

欢迎为学习目的使用、阅读和改这个项目。请用下面的拉取请求把改进送回来。

You are welcome to use, read, and change this project for learning. Send improvements back with a pull request, as described below.

## 一起改 / Contributing

克隆下来的是一份你自己的副本。直接 `git push` 到 [XiaobenkangDD/Aerie](https://github.com/XiaobenkangDD/Aerie) 会被拒绝。只有被加为协作者的人才能直接推送到这个仓库。

A clone is your own copy. A direct `git push` to [XiaobenkangDD/Aerie](https://github.com/XiaobenkangDD/Aerie) is rejected. Only people added as collaborators can push straight to this repository.

请这样送改动：

1. 点仓库页的 Fork，得到你账号下的一份仓库。
2. 在你的仓库里改，提交，再推送到你自己的 Fork。
3. 在原仓库打开 Pull Request。
4. 维护者看过之后合并。合并之后，这些改动才出现在这个仓库里。

To send a change:

1. Fork the repository into your own account.
2. Commit on your fork and push there.
3. Open a pull request against this repository.
4. A maintainer reviews it and merges it. Only then does the change land here.

如果你希望某几个人不必 Fork、可以直接推送，打开仓库的 Settings → Collaborators，把他们加进来，权限选 Write。不要把仓库设成任何人都能推。

To let a few people push without forking, open Settings → Collaborators and grant them Write. Do not allow the public to push.

## 环境 / Requirements

- Node.js 22
- macOS，才能用上 QuickLook 和 Vision / macOS for QuickLook and Vision
- 画面文字识别需要本机能运行 `swift`（Xcode 命令行工具）/ Text recognition needs `swift` on the machine (Xcode Command Line Tools)

`better-sqlite3` 必须按 Electron 的 ABI 编译。`npm install` 会自动跑 `electron-rebuild`。换过 Electron 版本后如果数据库打不开，再执行一次 `npm run rebuild`。

`better-sqlite3` must be compiled for Electron's ABI. `npm install` runs `electron-rebuild`. If the database fails to open after an Electron upgrade, run `npm run rebuild`.

## 常用命令 / Commands

```bash
npm install
npm run dev          # 开发。改界面会热更新 / dev server; renderer changes hot-reload
npm run typecheck    # 主进程 + 界面 / main and renderer
npm run test:features
npm run build
npm run dist         # 未签名的 macOS 目录包，输出在 release/ / unsigned macOS app in release/
```

| 命令 Command | 做什么 What it does |
|---|---|
| `npm run dev` | 先跑 `scripts/name-dev-app.mjs`，再启动 electron-vite。Runs the dock-name script, then electron-vite. |
| `npm run typecheck:node` / `typecheck:web` | 只查主进程或只查界面。Typecheck main or renderer only. |
| `npm run test:features` | 临时库上的功能测试，不打开窗口，不碰用户的照片。Feature tests on a temp library. No window, no personal photos. |
| `npm run test:lru` | 缩略图缓存淘汰。Thumbnail cache eviction. |
| `npm run verify -- /path/to/photos` | 用指定目录走一遍真实导入。不写路径时会去扫脚本里的默认照片目录。Import a real folder. With no path, the script uses its built-in default photo directory. |
| `npm run dist:dmg` | 未签名 dmg。Unsigned dmg. |

开发时改 `src/renderer` 保存即可。改 `src/main`、`src/preload` 或原生模块后，要停掉再重新 `npm run dev`，热更新不会带上主进程。

Renderer edits in `src/renderer` reload on save. After changing `src/main`, `src/preload`, or a native module, stop the app and run `npm run dev` again. Hot reload does not pick up the main process.

`scripts/name-dev-app.mjs` 只在 macOS 上跑。它把开发用的 `Electron.app` 改名为 `影巢.app`，让程序坞显示「影巢」。这个改动在 `node_modules` 里，不要提交。

`scripts/name-dev-app.mjs` runs only on macOS. It renames the development `Electron.app` to `影巢.app` so the Dock shows 影巢. That change stays in `node_modules`. Do not commit it.

## 目录 / Layout

```
src/shared/types.ts     IPC 名字、数据结构、window.aerie 的类型。改接口从这里开始
                        IPC names, data types, and the window.aerie contract. Start here.
src/preload/index.ts    渲染进程唯一能调用的接口 / the only API the renderer can call
src/main/index.ts       窗口、协议、生命周期 / window, protocols, lifecycle
src/main/menu.ts        中文应用菜单 / Chinese application menu
src/main/ipc/routes.ts  IPC 实现 / IPC handlers
src/main/db/schema.ts   新库的建表语句 / CREATE TABLE for new libraries
src/main/db/index.ts    打开数据库、schema 版本、老库迁移 / open, version, migrations
src/main/library/       开库、查询、修改、撤销、监视文件夹 / open, query, edit, undo, watch
src/main/importer/      扫描和导入 / scan and import
src/main/thumbs/        缩略图生成和缓存 / thumbnail build and cache
src/main/analyze/       指纹、主色、拍摄时间、OCR / fingerprint, palette, date, OCR
src/renderer/src/       界面。main.tsx 是主窗口，overlays.tsx 是大图和对话框
                        UI. main.tsx is the window, overlays.tsx is the viewer and dialogs.
extensions/aerie-chrome 本机浏览器收藏扩展 / local browser-collect extension
test/features.ts        功能测试 / feature tests
```

渲染进程开了 `contextIsolation` 和 `sandbox`，不能 `require`，也不能读任意文件。缩略图用 `aerie-thumb://`，原图用 `aerie-file://`。

The renderer uses `contextIsolation` and `sandbox`. It cannot `require` or read arbitrary files. Thumbnails use `aerie-thumb://`. Originals use `aerie-file://`.

## 改一处功能时要动哪里 / Where to change a feature

加一个界面能调用的能力：

1. `src/shared/types.ts` 里加上 IPC 名字和 `AerieApi` 方法
2. `src/preload/index.ts` 用 `ipcRenderer.invoke` 接出去
3. `src/main/ipc/routes.ts` 里实现

To add something the UI can call:

1. Add the IPC name and the `AerieApi` method in `src/shared/types.ts`.
2. Expose it from `src/preload/index.ts` with `ipcRenderer.invoke`.
3. Implement it in `src/main/ipc/routes.ts`.

改表结构见下一节。不要在界面里直接写 SQL。

Schema changes are in the next section. Do not write SQL in the UI.

## 数据库迁移 / Schema migrations

当前 `SCHEMA_VERSION` 是 7，定义在 `src/main/db/index.ts`。

`SCHEMA_VERSION` is 7, in `src/main/db/index.ts`.

老库打开时会先执行 `SCHEMA_SQL`。那里的 `CREATE TABLE IF NOT EXISTS` 不会给已经存在的表补新列。所以：

1. 把 `SCHEMA_VERSION` 加 1
2. 新库用的列写进 `schema.ts` 的 `CREATE TABLE`
3. 另写一个 `ensureV*`：先 `ALTER TABLE` 补列，再创建用到这列的索引
4. 在 `migrate()` 里调用它

Opening an old library runs `SCHEMA_SQL` first. `CREATE TABLE IF NOT EXISTS` does not add columns to a table that already exists. So:

1. Increment `SCHEMA_VERSION`.
2. Put the new column on the `CREATE TABLE` in `schema.ts` for new libraries.
3. Add an `ensureV*` that runs `ALTER TABLE` first, then creates any index that uses the new column.
4. Call it from `migrate()`.

索引如果写在 `SCHEMA_SQL` 里、又用了新列，老库会在 `ALTER` 之前失败。

An index in `SCHEMA_SQL` that uses a new column fails on old libraries, because it runs before `ALTER`.

## 库文件夹 / Library folder

```
<name>.aerie/
├── library.json          库 id、名称、reference 或 copy / id, name, reference or copy
├── aerie.db              SQLite，WAL
├── aerie.db-wal
├── thumbs/{sm,md,lg}/    256 / 512 / 1280 webp，删了会按需重建 / rebuilt on demand if deleted
└── files/                只有「复制库」才有，按 id 前两位分子目录
                          copy mode only, sharded by the first two id characters
```

引用库不搬动原文件。清空回收站只删索引，不删磁盘上的原文件。

A reference library does not move originals. Emptying the trash removes index rows only. It does not delete the files on disk.

开发时的最近打开记录在 `~/Library/Application Support/Aerie/`。显示名改成影巢之后，这个目录名仍是 Aerie，避免把已经记下的库弄丢。

Recent libraries in development are stored in `~/Library/Application Support/Aerie/`. The folder stays named Aerie after the display name became 影巢, so existing library records are not lost.

## 平台差异 / Platforms

| 能力 Capability | macOS | 其它系统 Other systems |
|---|---|---|
| 库、搜索、文件夹、标签、常见图片缩略图 Library, search, folders, tags, everyday thumbnails | 有 Yes | 代码能跑，没有现成安装包 The code can run; there is no installer yet |
| PSD、AI、PDF、视频、字体预览 Design, PDF, video, and font previews | QuickLook | 跳过 Skipped |
| 画面文字识别 Text recognition | Vision | 跳过，侧栏会说明原因 Skipped; the sidebar explains why |
| 程序坞名称 Dock name | `name-dev-app.mjs` 改成影巢 Renamed to 影巢 | 不跑这段脚本 Script does not run |

## 技术栈 / Stack

Electron 35、React 19、TypeScript 5.7、Vite 6 / electron-vite、better-sqlite3、sharp。网格是自己写的虚拟滚动。

Electron 35, React 19, TypeScript 5.7, Vite 6 / electron-vite, better-sqlite3, and sharp. The grid is a custom virtual scroller.

## 许可 / License

个人学习和自用免费，禁止商用。全文在 `LICENSE`。项目依赖的第三方库仍使用它们各自的许可。

Free for personal learning and personal use. Commercial use is not allowed. The full text is in `LICENSE`. Third-party dependencies keep their own licenses.
