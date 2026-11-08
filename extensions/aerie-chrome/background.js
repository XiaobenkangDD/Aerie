// 右键图片时，把图片地址和所在页面发给本机的 Aerie。
// token 和端口由用户从 Aerie 设置里复制，存在扩展自己的 storage 里。

const MENU_ID = 'aerie-save'

function installMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '收藏到影巢',
      contexts: ['image'],
    })
  })
}

chrome.runtime.onInstalled.addListener(installMenu)
installMenu()

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) return
  const stored = await chrome.storage.local.get({ token: '', port: 47321 })
  if (!stored.token) {
    await chrome.storage.local.set({ lastResult: '先在扩展弹窗里填上影巢的 token' })
    return
  }
  const port = Number(stored.port) || 47321
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${stored.token}`,
      },
      body: JSON.stringify({
        imageUrl: info.srcUrl,
        pageUrl: info.pageUrl || tab?.url || '',
        title: tab?.title || '',
      }),
    })
    const body = await response.json().catch(() => ({}))
    const message = response.ok ? '已收藏到影巢' : body.error || `收藏失败（${response.status}）`
    await chrome.storage.local.set({ lastResult: message })
  } catch {
    await chrome.storage.local.set({ lastResult: '连不上影巢。确认库已打开，并且端口、token 没填错。' })
  }
})
