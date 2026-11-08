const portInput = document.getElementById('port')
const tokenInput = document.getElementById('token')
const hint = document.getElementById('hint')

chrome.storage.local.get({ token: '', port: 47321, lastResult: '' }).then((stored) => {
  portInput.value = stored.port || 47321
  tokenInput.value = stored.token || ''
  if (stored.lastResult) hint.textContent = stored.lastResult
})

document.getElementById('save').addEventListener('click', async () => {
  const port = Number(portInput.value) || 47321
  const token = tokenInput.value.trim()
  await chrome.storage.local.set({ token, port, lastResult: '' })
  hint.textContent = token ? '已保存。到网页图片上右键收藏。' : '还没有 token。'
})
