/**
 * 应用菜单栏。
 *
 * 开发时 Electron 自带的是英文 File / Edit / View，里面还有重载和开发者工具。
 * 这里换成和库操作对应的中文菜单。系统动作仍用 role，但标题写明中文，
 * 避免和自定义项混成中英两套。点菜单或按快捷键都发给界面，
 * 由界面决定是改文字框还是改素材，避免快捷键在搜索框里误导入。
 */
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import { IPC, type MenuCommand } from '../shared/types.js'
import { readRecent, type RecentEntry } from './library/recent.js'

function send(command: MenuCommand, arg?: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.menuCommand, command, arg)
}

function commandItem(
  label: string,
  command: MenuCommand,
  opts: { accelerator?: string; enabled?: boolean; arg?: string } = {},
): MenuItemConstructorOptions {
  return {
    label,
    accelerator: opts.accelerator,
    enabled: opts.enabled !== false,
    click: () => send(command, opts.arg),
  }
}

function recentLabel(entry: RecentEntry, all: RecentEntry[]): string {
  const duplicated = all.filter((row) => row.name === entry.name).length > 1
  if (!duplicated) return entry.name
  return `${entry.name} — ${path.basename(path.dirname(entry.path))}`
}

export function syncAppMenu(libraryOpen: boolean, currentPath: string | null = null): void {
  const open = libraryOpen
  const recent = readRecent()
  const recentMenu: MenuItemConstructorOptions[] =
    recent.length > 0
      ? recent.map((entry) => ({
          label: recentLabel(entry, recent),
          type: 'radio' as const,
          checked: entry.path === currentPath,
          click: () => send('open-recent', entry.path),
        }))
      : [{ label: '没有最近打开的库', enabled: false }]

  const viewMenu: MenuItemConstructorOptions[] = [
    commandItem('网格', 'layout-grid', { accelerator: 'CmdOrCtrl+1', enabled: open }),
    commandItem('列表', 'layout-list', { accelerator: 'CmdOrCtrl+2', enabled: open }),
    commandItem('瀑布', 'layout-waterfall', { accelerator: 'CmdOrCtrl+3', enabled: open }),
    { type: 'separator' },
    commandItem('放大缩略图', 'zoom-in', { accelerator: 'CmdOrCtrl+Plus', enabled: open }),
    commandItem('缩小缩略图', 'zoom-out', { accelerator: 'CmdOrCtrl+-', enabled: open }),
    commandItem('默认大小', 'zoom-reset', { accelerator: 'CmdOrCtrl+0', enabled: open }),
    { type: 'separator' },
    commandItem('搜索', 'focus-search', { accelerator: 'CmdOrCtrl+F', enabled: open }),
    { type: 'separator' },
    commandItem('查找相似', 'find-similar', { enabled: open }),
    commandItem('检查缺失文件', 'check-missing', { enabled: open }),
    commandItem('按文件夹接回…', 'relink-folder', { enabled: open }),
  ]

  if (!app.isPackaged) {
    viewMenu.push(
      { type: 'separator' },
      { role: 'reload', label: '重新载入' },
      { role: 'toggleDevTools', label: '开发者工具' },
    )
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: '影巢',
      submenu: [
        { label: '关于影巢', click: () => app.showAboutPanel() },
        { type: 'separator' },
        ...(process.platform === 'darwin'
          ? ([
              { role: 'services', label: '服务' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏影巢' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '显示全部' },
              { type: 'separator' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { role: 'quit', label: '退出影巢' },
      ],
    },
    {
      label: '文件',
      submenu: [
        commandItem('新建引用库…', 'new-reference', { accelerator: 'CmdOrCtrl+N' }),
        commandItem('新建复制库…', 'new-copy', { accelerator: 'CmdOrCtrl+Shift+N' }),
        commandItem('打开资源库…', 'open-library', { accelerator: 'CmdOrCtrl+Shift+O' }),
        { label: '最近打开', submenu: recentMenu },
        commandItem('关闭资源库', 'close-library', { enabled: open }),
        { type: 'separator' },
        commandItem('导入文件…', 'import-files', { accelerator: 'CmdOrCtrl+O', enabled: open }),
        commandItem('导入文件夹…', 'import-folder', { accelerator: 'CmdOrCtrl+Alt+O', enabled: open }),
        commandItem('从剪贴板导入', 'paste-import', { accelerator: 'CmdOrCtrl+Shift+V', enabled: open }),
        { type: 'separator' },
        commandItem('导出选中…', 'export', { accelerator: 'CmdOrCtrl+Shift+E', enabled: open }),
        { type: 'separator' },
        commandItem('新建文件夹…', 'new-folder', { enabled: open }),
        commandItem('新建标签…', 'new-tag', { enabled: open }),
      ],
    },
    {
      label: '编辑',
      submenu: [
        commandItem('撤销', 'undo', { accelerator: 'CmdOrCtrl+Z', enabled: open }),
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        commandItem('粘贴', 'paste', { accelerator: 'CmdOrCtrl+V' }),
        commandItem('全选', 'select-all', { accelerator: 'CmdOrCtrl+A' }),
        { type: 'separator' },
        commandItem('重命名…', 'rename', { enabled: open }),
        commandItem('移入回收站', 'trash', { enabled: open }),
      ],
    },
    { label: '显示', submenu: viewMenu },
    {
      label: '窗口',
      role: 'window',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏幕' },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
