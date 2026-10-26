/**
 * lib/gallery.mjs —— 图库：列目录、喜好、删除（进垃圾桶）、还原、彻底删除
 * ============================================================================
 * 两种模式，自动判断：
 *
 * ① 作品模式（有 <root>/<metaDir>/*.json）
 *    每个 json 是一件作品：{ id, title, artist, rating, dir, files: [{name,page}], fav }
 *    —— 刷 Pixiv 插件存下来的就是这个形状，两个插件天然配合。
 *
 * ② 纯图片模式（没有 _meta）
 *    把图库目录里的图片文件直接当作品，一张一件；按路径猜 R18；喜好存在插件家目录。
 *    —— 别人没装抓取插件时，指一个图片文件夹就能用。
 * ============================================================================
 */
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, renameSync, unlinkSync, rmdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const IMG = /\.(jpe?g|png|gif|webp|avif|bmp)$/i
const MAX_DEPTH = 4

/** 文件名里的页号：`123_7.jpg` → 7 */
function pageOf(name) {
  const m = /_(\d+)\.[a-z0-9]+$/i.exec(String(name))
  return m ? Number(m[1]) : 0
}

function sortPages(list) {
  return [...list].sort((a, b) => {
    const pa = Number(a.page) || pageOf(a.name)
    const pb = Number(b.page) || pageOf(b.name)
    return pa - pb || String(a.name).localeCompare(String(b.name))
  })
}

function toRel(root, abs) {
  return relative(root, abs).replace(/\\/g, '/')
}

/** 路径里带 R-18 / R18 的，算 R18 */
function guessRating(relPath) {
  return /(^|[\\/])(r-?18)([\\/]|$)/i.test(String(relPath)) ? 'r18' : 'all'
}

/**
 * 列图库。
 * @returns {{mode:'meta'|'plain', items:Array, total:number}}
 */
export function listGallery(root, { metaDir = '_meta', trashDir = '_trash', limit = 120, state = {} } = {}) {
  const metaRoot = join(root, metaDir)
  const favMap = state?.fav && typeof state.fav === 'object' ? state.fav : {}

  // ① 作品模式
  const items = []
  let metaFiles = []
  try {
    metaFiles = readdirSync(metaRoot).filter((n) => n.toLowerCase().endsWith('.json'))
  } catch { metaFiles = [] }

  if (metaFiles.length) {
    for (const name of metaFiles) {
      const metaFile = join(metaRoot, name)
      let meta = null
      try { meta = JSON.parse(readFileSync(metaFile, 'utf8')) } catch { continue }
      const dir = String(meta?.dir || '')
      const rows = (Array.isArray(meta?.files) ? meta.files : []).filter((f) => f && IMG.test(String(f.name || '')))
      let names = sortPages(rows).map((f) => f.name)
      if (!names.length && dir) {
        try { names = sortPages(readdirSync(dir).filter((n) => IMG.test(n)).map((n) => ({ name: n }))).map((x) => x.name) } catch { names = [] }
      }
      if (!names.length) continue
      const key = meta?.id !== undefined && meta?.id !== null ? `#${meta.id}` : `@${toRel(root, dir)}`
      const files = names.map((n) => toRel(root, join(dir, n)))
      items.push({
        key,
        id: Number.isFinite(Number(meta?.id)) ? Number(meta.id) : null,
        title: meta?.title || names[0],
        artist: meta?.artist?.name || meta?.artist || '',
        kind: meta?.kind || 'illust',
        rating: meta?.rating || guessRating(files[0] || ''),
        savedAt: meta?.savedAt || meta?.updatedAt || '',
        at: (() => { try { return statSync(metaFile).mtimeMs } catch { return 0 } })(),
        pages: files.length,
        files,
        dir: toRel(root, dir),
        thumb: files[0],
        fav: meta?.fav === true || favMap[key] === true,
      })
    }
    items.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')) || b.at - a.at)
    return { mode: 'meta', items: items.slice(0, limit), total: items.length }
  }

  // ② 纯图片模式：把图片文件当作品
  const skip = new Set([String(metaDir).toLowerCase(), String(trashDir).toLowerCase()])
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || items.length > limit * 4) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth === 0 && skip.has(e.name.toLowerCase())) continue
        walk(abs, depth + 1)
        continue
      }
      if (!e.isFile() || !IMG.test(e.name)) continue
      const rel = toRel(root, abs)
      let at = 0
      try { at = statSync(abs).mtimeMs } catch { /* 忽略 */ }
      const key = `@${rel}`
      items.push({
        key,
        id: null,
        title: e.name.replace(/\.[^.]+$/, ''),
        artist: toRel(root, dir) === '' ? '' : toRel(root, dir).split('/').slice(-1)[0],
        kind: 'image',
        rating: guessRating(rel),
        savedAt: new Date(at).toISOString(),
        at,
        pages: 1,
        files: [rel],
        dir: toRel(root, dir),
        thumb: rel,
        fav: favMap[key] === true,
      })
    }
  }
  walk(root, 0)
  items.sort((a, b) => b.at - a.at)
  return { mode: 'plain', items: items.slice(0, limit), total: items.length }
}

/** 找到一件作品的 metadata 文件（作品模式） */
export function findMetaFile(root, metaDir, key, id) {
  const metaRoot = join(root, metaDir)
  const want = id ?? (String(key).startsWith('#') ? Number(String(key).slice(1)) : NaN)
  if (Number.isFinite(want)) {
    const direct = join(metaRoot, `${want}.json`)
    if (existsSync(direct)) return direct
  }
  let hit = null
  let files = []
  try { files = readdirSync(metaRoot).filter((n) => n.toLowerCase().endsWith('.json')) } catch { return null }
  for (const n of files) {
    const f = join(metaRoot, n)
    try {
      const meta = JSON.parse(readFileSync(f, 'utf8'))
      const k = meta?.id !== undefined && meta?.id !== null ? `#${meta.id}` : `@${toRel(root, String(meta?.dir || ''))}`
      if (k === key) { hit = f; break }
    } catch { /* 跳过坏的 */ }
  }
  return hit
}

function moveFile(from, to) {
  try {
    renameSync(from, to)
  } catch (e) {
    if (e?.code !== 'EXDEV') throw e
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

function trashRootOf(root, trashDir) { return join(root, trashDir) }

function stampKey(key) {
  const safe = String(key).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40)
  const t = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${safe}-${t}`
}

/** 删除 = 挪进垃圾桶（可还原） */
export function trashItem({ root, metaDir, trashDir, key }) {
  const metaFile = findMetaFile(root, metaDir, key)
  let meta = null
  if (metaFile) {
    try { meta = JSON.parse(readFileSync(metaFile, 'utf8')) } catch { meta = null }
  }

  // 作品模式：按 metadata 里登记的页挪；纯图片模式：按 key 里的相对路径挪
  let dirAbs = ''
  let names = []
  if (meta) {
    dirAbs = String(meta.dir || '')
    const rows = (Array.isArray(meta.files) ? meta.files : []).filter((f) => f && IMG.test(String(f.name || '')))
    names = sortPages(rows).map((f) => f.name)
    if (!names.length && dirAbs) {
      try { names = readdirSync(dirAbs).filter((n) => IMG.test(n)) } catch { names = [] }
    }
  } else if (String(key).startsWith('@')) {
    const rel = String(key).slice(1)
    const abs = join(root, rel)
    dirAbs = join(abs, '..')
    names = [rel.split('/').pop()]
  }

  if (!dirAbs) return { ok: false, error: '找不到这件作品' }
  const resolvedDir = join(dirAbs)
  if (!resolvedDir.startsWith(root) && resolvedDir !== root) return { ok: false, error: '目录不在图库里，拒绝删除' }

  const binName = stampKey(key)
  const binAbs = join(trashRootOf(root, trashDir), binName)
  mkdirSync(binAbs, { recursive: true })

  const moved = []
  const missing = []
  const failed = []
  for (const name of names) {
    const src = join(resolvedDir, name)
    if (!existsSync(src)) { missing.push(name); continue }
    try { moveFile(src, join(binAbs, name)); moved.push(name) } catch (e) { failed.push(`${name}：${e?.message ?? e}`) }
  }
  try { rmdirSync(resolvedDir) } catch { /* 里面还有别的文件 */ }

  const payload = meta || {
    key,
    id: null,
    title: String(names[0] || key),
    rating: guessRating(names[0] || ''),
    dir: resolvedDir,
    files: names.map((n) => ({ name: n })),
    savedAt: '',
  }
  try {
    writeFileSync(join(binAbs, 'meta.json'), JSON.stringify({
      ...payload,
      __gallery: { key, deletedAt: new Date().toISOString(), dir: resolvedDir },
    }, null, 2), 'utf8')
  } catch (e) { failed.push(`meta.json：${e?.message ?? e}`) }
  if (metaFile) { try { unlinkSync(metaFile) } catch { /* 已经没了 */ } }

  return { ok: true, key, bin: binName, moved, missing, failed }
}

/** 垃圾桶列表 */
export function listTrash({ root, metaDir, trashDir, state = {} }) {
  const base = trashRootOf(root, trashDir)
  let dirs = []
  try { dirs = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { return [] }
  const out = []
  for (const d of dirs) {
    const abs = join(base, d.name)
    let meta = null
    try { meta = JSON.parse(readFileSync(join(abs, 'meta.json'), 'utf8')) } catch { meta = null }
    let files = []
    try { files = readdirSync(abs).filter((n) => n !== 'meta.json' && IMG.test(n)) } catch { /* 空 */ }
    const first = files[0]
    out.push({
      bin: d.name,
      key: meta?.__gallery?.key ?? meta?.key ?? '',
      id: Number.isFinite(Number(meta?.id)) ? Number(meta.id) : null,
      title: meta?.title || first || d.name,
      artist: meta?.artist?.name || meta?.artist || '',
      pages: files.length,
      deletedAt: meta?.__gallery?.deletedAt || '',
      thumb: first ? toRel(root, join(abs, first)) : '',
      fav: meta?.fav === true,
    })
  }
  out.sort((a, b) => String(b.bin).localeCompare(String(a.bin)))
  return out
}

/** 从垃圾桶还原 */
export function restoreItem({ root, metaDir, trashDir, bin }) {
  const abs = join(trashRootOf(root, trashDir), String(bin || ''))
  if (!existsSync(abs)) return { ok: false, error: '垃圾桶里没有这一件' }
  let meta = null
  try { meta = JSON.parse(readFileSync(join(abs, 'meta.json'), 'utf8')) } catch { meta = null }
  if (!meta) return { ok: false, error: '垃圾桶里的记录损坏了' }

  const backDir = String(meta.__gallery?.dir || meta.dir || '')
  if (!backDir || !(backDir === root || backDir.startsWith(root))) return { ok: false, error: '原来的目录不合法' }
  mkdirSync(backDir, { recursive: true })

  const restored = []
  const failed = []
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (!e.isFile() || e.name === 'meta.json') continue
    try { moveFile(join(abs, e.name), join(backDir, e.name)); restored.push(e.name) } catch (err) {
      failed.push(`${e.name}：${err?.message ?? err}`)
    }
  }

  // 作品模式：metadata 放回 _meta；纯图片模式就不用写回去了
  const id = Number(meta?.id)
  if (Number.isFinite(id)) {
    const dest = join(root, metaDir, `${id}.json`)
    try {
      mkdirSync(join(root, metaDir), { recursive: true })
      const { __gallery, ...clean } = meta
      writeFileSync(dest, JSON.stringify(clean, null, 2), 'utf8')
    } catch (e) { failed.push(`metadata：${e?.message ?? e}`) }
  }
  if (!failed.length) { try { rmSync(abs, { recursive: true, force: true }) } catch { /* 忽略 */ } }
  return { ok: failed.length === 0, bin, restored, failed }
}

/** 彻底删除（只删垃圾桶里的） */
export function purgeTrash({ root, trashDir, bin, all }) {
  const base = trashRootOf(root, trashDir)
  const purged = []
  if (all) {
    let dirs = []
    try { dirs = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()) } catch { return { ok: true, purged } }
    for (const d of dirs) {
      try { rmSync(join(base, d.name), { recursive: true, force: true }); purged.push(d.name) } catch { /* 忽略 */ }
    }
    return { ok: true, purged }
  }
  const abs = join(base, String(bin || ''))
  if (!abs.startsWith(base + sep) && abs !== base) return { ok: false, error: '路径不合法' }
  if (!existsSync(abs)) return { ok: false, error: '垃圾桶里没有这一件' }
  rmSync(abs, { recursive: true, force: true })
  purged.push(String(bin))
  return { ok: true, purged }
}
