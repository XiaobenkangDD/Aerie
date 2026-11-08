/**
 * 判断 child 是不是 parent 自己，或落在 parent 里面。
 * 用来避免把库目录、缩略图再导一遍。
 */
import path from 'node:path'

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
