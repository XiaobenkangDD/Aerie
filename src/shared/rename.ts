/**
 * 批量重命名模板。
 *
 *   {name}     原来的显示名
 *   {ext}      扩展名
 *   {index}    序号，从调用方给的起点开始
 *   {index:3}  序号，至少 3 位，不足补 0
 */

export function renderNameTemplate(
  template: string,
  vars: { name: string; ext: string; index: number },
): string {
  return template.replace(/\{(name|ext|index(?::(\d+))?)\}/gi, (_full, key: string, width?: string) => {
    const k = key.toLowerCase()
    if (k === 'name') return vars.name
    if (k === 'ext') return vars.ext
    const w = width ? Math.min(8, Math.max(0, Number(width))) : 0
    const text = String(vars.index)
    return w > 0 ? text.padStart(w, '0') : text
  })
}

/** 磁盘文件名里不能出现的字符换成空格。空结果退回 untitled，避免变成隐藏文件。 */
export function safeFileStem(name: string): string {
  const cleaned = name.replace(/[\\/:\0]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'untitled'
  return cleaned
}
