/**
 * 把用户选中的文件夹解析成真正的库目录。
 *
 * 库是「名字.aerie」，里面有 library.json。
 * 选照片目录、或选到库里面的某个子文件夹时，往旁边找这个库，
 * 避免把「写真」当成库然后报缺少 library.json。
 */
import fs from 'node:fs'
import path from 'node:path'

export const LIBRARY_EXT = '.aerie'

export function resolveLibraryRoot(input: string): string {
  const resolved = path.resolve(input)
  if (!fs.existsSync(resolved)) {
    throw new Error(`找不到这个路径：${resolved}`)
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`请选择文件夹：${resolved}`)
  }

  if (hasMeta(resolved)) return resolved

  const nested = librariesIn(resolved)
  const named = pickNamed(resolved, nested)
  if (named) return named
  if (nested.length > 1) {
    throw new Error(`这里有多个库（${namesOf(nested)}）。请直接选中其中一个 ${LIBRARY_EXT} 文件夹。`)
  }

  const parent = path.dirname(resolved)
  if (parent !== resolved) {
    const beside = librariesIn(parent)
    const parentNamed = pickNamed(parent, beside)
    if (parentNamed) return parentNamed
    if (beside.length === 1) return beside[0]
  }

  throw new Error(
    `「${path.basename(resolved)}」不是影巢库。库是以 ${LIBRARY_EXT} 结尾的文件夹。照片目录要先新建库，再用「导入文件夹」加进来。`,
  )
}

function hasMeta(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'library.json'))
}

function librariesIn(dir: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith(LIBRARY_EXT) && !name.startsWith('.'))
    .map((name) => path.join(dir, name))
    .filter((dirPath) => {
      try {
        return fs.statSync(dirPath).isDirectory() && hasMeta(dirPath)
      } catch {
        return false
      }
    })
}

/** 只有一个库就用它；有多个时，优先用和所在文件夹同名的那个。 */
function pickNamed(dir: string, candidates: string[]): string | null {
  if (candidates.length === 1) return candidates[0]
  const preferred = `${path.basename(dir)}${LIBRARY_EXT}`
  return candidates.find((dirPath) => path.basename(dirPath) === preferred) ?? null
}

function namesOf(dirs: string[]): string {
  return dirs.map((dirPath) => path.basename(dirPath)).join('、')
}
