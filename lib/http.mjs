/**
 * lib/http.mjs —— 图库的后端接口（双通道）
 * ============================================================================
 * DSH 桌面版不监听 TCP：UI 由 Electron 自定义协议承载，所以要走
 *   `ctx.connection.fetch.register({ path:'/api/gallery/…' })`
 * Web/源码模式再挂一条 `ctx.webServer.register({ kind:'prefix', path:'/gallery/api' })`。
 * 前端会先探 `/api/gallery/ping`，不通再退回 `/gallery/api/ping`。
 *
 * 图片字节不走 JSON 层（`<img src>` 打的是普通 HTTP），单独挂 `/gallery-img`。
 * ============================================================================
 */
import { existsSync, readdirSync, readFileSync, createReadStream, mkdirSync, writeFileSync, renameSync, appendFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { join, resolve, sep, extname, dirname } from 'node:path'
import { loadCfg, saveCfg, resolveRoot, readState, writeState, rootExists } from './config.mjs'
import { listGallery, trashItem, listTrash, restoreItem, purgeTrash, purgeOldTrash, findMetaFile } from './gallery.mjs'
import { buildStats } from './stats.mjs'
import { ensureThumb, thumbAbs } from './thumbs.mjs'

const API_BASE = '/api/gallery'
const LEGACY_PREFIX = '/gallery/api'
const MAX_BODY = 256 * 1024

const IMG_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
}

/** 宿主服务：cordis 里未 inject 的属性会抛错，属性和 ctx.get 要分开试 */
function svc(ctx, name) {
  try { const v = ctx[name]; if (v) return v } catch { /* 未 inject */ }
  try { return typeof ctx.get === 'function' ? ctx.get(name) : undefined } catch { return undefined }
}


/** 后台补缩略图：只补缺的，串行生成；同一时间只跑一条链，避免反复列图库时堆任务 */
let warming = false
function warmThumbs(root, items, log) {
  if (warming) return
  try {
    const missing = items.filter((it) => it.thumb && !existsSync(thumbAbs(root, it.thumb)))
    if (!missing.length) return
    warming = true
    let i = 0
    const step = () => {
      if (i >= missing.length) { warming = false; return }
      const it = missing[i++]
      ensureThumb(root, it.thumb, join(root, it.thumb), { maxEdge: 480 })
        .catch(() => {})
        .finally(() => setTimeout(step, 50))
    }
    setTimeout(step, 200)
  } catch (e) { warming = false; log?.(`缩略图预热失败：${e?.message ?? e}`) }
}


/** 关注索引：following.json（Pixiv 真实关注）+ follow-queue.jsonl（排队中） */
function buildFollowIndex(pixivHome) {
  const ids = new Set()
  const names = new Set()
  const pending = new Set()
  try {
    const raw = readFileSync(join(pixivHome, 'following.json'), 'utf8')
    const list = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : []
    for (const u of list) {
      if (Number.isFinite(Number(u?.id))) ids.add(Number(u.id))
      if (u?.name) names.add(String(u.name).trim())
    }
  } catch { /* 没有缓存 */ }
  try {
    for (const line of readFileSync(join(pixivHome, 'follow-queue.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (Number.isFinite(Number(o?.artistId))) pending.add(Number(o.artistId))
        if (o?.artistName) names.add(String(o.artistName).trim())
      } catch { /* 跳过 */ }
    }
  } catch { /* 没有队列 */ }
  const pendingUnfollow = new Set()
  try {
    for (const line of readFileSync(join(pixivHome, 'unfollow-queue.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const o = JSON.parse(line)
        if (Number.isFinite(Number(o?.artistId))) pendingUnfollow.add(Number(o.artistId))
      } catch { /* 跳过 */ }
    }
  } catch { /* 没有队列 */ }
  return { ids, names, pending, pendingUnfollow }
}

/** 给一件作品标注关注状态 */
function markFollow(items, root, idx) {
  for (const it of items) {
    const id = Number(it.artistId)
    const name = String(it.artist || '').trim()
    let followed = false
    // 作品本身就在 关注/ 目录里 —— 来源就是关注流，比关注列表更可靠
    const inFollowDir = String(it.dir || '').replace(/\\/g, '/').startsWith('关注')
    if (inFollowDir) followed = true
    else if (Number.isFinite(id) && idx.ids.has(id)) followed = true
    else if (name && idx.names.has(name)) followed = true
    // 注：不再用「关注/<画师> 文件夹存在」当关注依据 —— 取消关注后文件夹会原地保留，靠它判断会一直误报「已关注」
    it.followed = followed
    it.pendingFollow = !followed && Number.isFinite(id) && idx.pending.has(id)
    it.pendingUnfollow = followed && Number.isFinite(id) && idx.pendingUnfollow.has(id)
  }
  return items
}

/**
 * 画师作品整体搬动（幂等）：
 *   to='follow' → 收进 `关注/<画师>/`
 *   to='out'    → 放回评级对应的目录（all → 普通插画，r18 → R-18）
 * 按画师 ID 匹配 metadata，搬完同步改写 meta.dir（图库靠它定位图片）。
 */
export function moveArtistWorks(root, metaDirName, artistId, artistName, opts = {}) {
  const id = Number(artistId)
  const { followDir = '关注', normalDir = '普通插画', r18Dir = 'R-18', to = 'follow' } = opts
  if (!Number.isFinite(id) || id <= 0) return { moved: 0, target: '', followPath: '', dirs: 0 }
  const metaRoot = join(root, metaDirName || '_meta')
  if (!existsSync(metaRoot)) return { moved: 0, target: '', followPath: '', dirs: 0 }

  const safeName = String(artistName || '').trim().replace(/[\\/:*?"<>|]/g, '_') || 'unknown'
  const followPath = join(root, followDir || '关注', safeName)
  const outNormal = join(root, normalDir || '普通插画')
  const outR18 = join(root, r18Dir || 'R-18')

  const moveOne = (src, dst) => {
    try { renameSync(src, dst); return true } catch {
      try { copyFileSync(src, dst); unlinkSync(src); return true } catch { return false }
    }
  }

  let moved = 0
  const dirs = new Set()
  for (const name of readdirSync(metaRoot)) {
    if (!name.toLowerCase().endsWith('.json')) continue
    const metaFile = join(metaRoot, name)
    let meta = null
    try { meta = JSON.parse(readFileSync(metaFile, 'utf8')) } catch { continue }
    if (!meta || typeof meta !== 'object') continue
    const aid = Number(meta?.artist?.id)
    const aname = String(meta?.artist?.name || '').trim()
    const hit = Number.isFinite(aid) ? aid === id : Boolean(aname) && aname === String(artistName).trim()
    if (!hit) continue
    const from = String(meta?.dir || '')
    if (!from) continue
    const target = to === 'follow'
      ? followPath
      : join(root, String(meta.rating || 'all') === 'all' ? normalDir || '普通插画' : r18Dir || 'R-18')
    if (resolve(from) === resolve(target)) continue
    if (!existsSync(from)) continue
    mkdirSync(target, { recursive: true })
    let touched = false
    for (const f of Array.isArray(meta.files) ? meta.files : []) {
      const rel = String(f?.name || '')
      if (!rel || rel.includes('..') || /[\\/]/.test(rel)) continue
      const src = join(from, rel)
      const dst = join(target, rel)
      if (!existsSync(src)) continue
      if (existsSync(dst)) { touched = true; continue }
      if (moveOne(src, dst)) { moved++; touched = true }
    }
    if (touched) {
      meta.dir = target
      try { writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8') } catch { /* 忽略 */ }
      dirs.add(from)
    }
  }
  return { moved, target: to === 'follow' ? followPath : '', followPath, dirs: dirs.size }
}

/** 只收进「关注」图库（点关注时用） */
export function adoptArtistWorks(root, metaDirName, followDirName, artistId, artistName = '') {
  return moveArtistWorks(root, metaDirName, artistId, artistName, { followDir: followDirName || '关注', to: 'follow' })
}

function createApi({ home, log = () => {} }) {
  const cfgNow = () => loadCfg(home)
  const ctxOf = () => {
    const cfg = cfgNow()
    const root = resolve(resolveRoot(cfg, home))
    return { cfg, root }
  }

  return {
    async handle(method, path, query, body) {
      try {
        if (path === '/ping') return { status: 200, body: { ok: true, plugin: 'dsh-gallery' } }

        if (path === '/config' && method === 'GET') {
          const cfg = cfgNow()
          const root = resolve(resolveRoot(cfg, home))
          return {
            status: 200,
            body: {
              ok: true, cfg, root,
              exists: existsSync(root),
              defaults: { title: '我的图库' },
            },
          }
        }

        if (path === '/config' && method === 'POST') {
          const patch = {}
          for (const k of ['title', 'root', 'metaDir', 'trashDir', 'pageLimit', 'enabled']) {
            if (body && body[k] !== undefined) patch[k] = body[k]
          }
          const cfg = saveCfg(home, patch)
          log(`配置更新：title=${cfg.title} root=${cfg.root || '(默认)'}`)
          return { status: 200, body: { ok: true, cfg, root: resolve(resolveRoot(cfg, home)) } }
        }

        if (path === '/gallery' && method === 'GET') {
          const { cfg, root } = ctxOf()
          if (!existsSync(root)) {
            return { status: 200, body: { ok: true, root, exists: false, mode: 'none', items: [], total: 0 } }
          }
          const limit = Math.min(500, Math.max(1, Number(query.get('limit') || cfg.pageLimit || 120)))
          const st = readState(home)
          const listed = listGallery(root, { metaDir: cfg.metaDir, trashDir: cfg.trashDir, limit, state: st })
          try {
            const pixivHome = join(dirname(home), 'pixiv-duty')
            if (existsSync(pixivHome)) markFollow(listed.items, root, buildFollowIndex(pixivHome))
          } catch { /* 打标失败不影响看图 */ }
          // 顺手清理垃圾桶里放太久的（默认 7 天）
          try {
            const gone = purgeOldTrash({ root, trashDir: cfg.trashDir, days: Number(cfg.trashKeepDays) })
            if (gone.length) log(`垃圾桶自动清理 ${gone.length} 件（超过 ${cfg.trashKeepDays} 天）`)
          } catch { /* 忽略 */ }
          warmThumbs(root, listed.items, log)
          return { status: 200, body: { ok: true, root, exists: true, ...listed } }
        }

        if (path === '/gallery/fav' && method === 'POST') {
          const { cfg, root } = ctxOf()
          const key = String(body?.key || '')
          if (!key) return { status: 400, body: { ok: false, error: 'key 不能为空' } }
          const fav = Boolean(body?.fav)

          // 作品模式：写进 metadata；纯图片模式：写插件家目录的 state.json
          const metaFile = findMetaFile(root, cfg.metaDir, key)
          if (metaFile) {
            let meta = null
            try { meta = JSON.parse(readFileSync(metaFile, 'utf8')) } catch { meta = null }
            if (!meta) return { status: 500, body: { ok: false, error: 'metadata 损坏' } }
            meta.fav = fav
            meta.favAt = fav ? new Date().toISOString() : null
            const tmp = `${metaFile}.tmp`
            writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8')
            renameSync(tmp, metaFile)
          } else {
            const st = readState(home)
            st.fav = st.fav && typeof st.fav === 'object' ? st.fav : {}
            if (fav) st.fav[key] = true
            else delete st.fav[key]
            writeState(home, st)
          }
          return { status: 200, body: { ok: true, key, fav } }
        }

        if (path === '/gallery/delete' && method === 'POST') {
          const { cfg, root } = ctxOf()
          const key = String(body?.key || '')
          if (!key) return { status: 400, body: { ok: false, error: 'key 不能为空' } }
          const r = trashItem({ root, metaDir: cfg.metaDir, trashDir: cfg.trashDir, key })
          if (!r.ok) return { status: 400, body: r }
          log(`图库入垃圾桶 ${key}：${r.moved.length} 个文件`)
          return { status: 200, body: r }
        }

        if (path === '/gallery/trash' && method === 'GET') {
          const { cfg, root } = ctxOf()
          const items = listTrash({ root, metaDir: cfg.metaDir, trashDir: cfg.trashDir })
          return { status: 200, body: { ok: true, items, count: items.length } }
        }

        if (path === '/gallery/restore' && method === 'POST') {
          const { cfg, root } = ctxOf()
          const bin = String(body?.bin || '')
          if (!bin) return { status: 400, body: { ok: false, error: 'bin 不能为空' } }
          const r = restoreItem({ root, metaDir: cfg.metaDir, trashDir: cfg.trashDir, bin })
          if (r.ok) log(`图库还原 ${bin}：${r.restored.length} 个文件`)
          return { status: r.ok ? 200 : 400, body: r }
        }

        if (path === '/gallery/purge' && method === 'POST') {
          const { cfg, root } = ctxOf()
          const r = purgeTrash({ root, trashDir: cfg.trashDir, bin: body?.bin, all: body?.all === true })
          if (r.ok) log(`图库彻底删除：${r.purged.length} 件`)
          return { status: r.ok ? 200 : 400, body: r }
        }

        // ── 关注画师（延迟）：图库只管排队，真正关注由刷 Pixiv 插件下一轮去做 ──
        if (path === '/gallery/follow-artist' && method === 'POST') {
          const id = Number(body?.artistId)
          if (!Number.isFinite(id) || id <= 0) return { status: 400, body: { ok: false, error: '缺少 artistId' } }
          const pixivHome = join(dirname(home), 'pixiv-duty')
          if (!existsSync(pixivHome)) {
            return { status: 400, body: { ok: false, error: '没找到刷 Pixiv 插件的数据目录（$DSH_HOME/pixiv-duty）' } }
          }
          const qf = join(pixivHome, 'follow-queue.jsonl')
          const line = JSON.stringify({
            artistId: id,
            artistName: String(body?.artistName || '').slice(0, 80),
            at: new Date().toISOString(),
          })
          try {
            appendFileSync(qf, line + '\n', 'utf8')
          } catch (e) {
            return { status: 500, body: { ok: false, error: '写队列失败：' + (e?.message ?? e) } }
          }
          // 排队即归位：不等真正关注成功，先把这位画师本地散落的图收进 关注/<画师>/
          try {
            const { cfg, root } = ctxOf()
            const r = adoptArtistWorks(
              root,
              cfg.metaDir || '_meta',
              cfg.followDir || '关注',
              id,
              String(body?.artistName || '').slice(0, 80),
            )
            if (r.moved) log(`关注归位（排队中）：${body?.artistName || id} → ${r.target}（挪 ${r.moved} 个文件）`)
          } catch (e) {
            log(`关注归位失败（不影响排队）：${e?.message ?? e}`)
          }
          return { status: 200, body: { ok: true, queued: true } }
        }

        // ── 取消关注（延迟）：同样只排队，由刷 Pixiv 插件下一轮去真正取消 ──
        if (path === '/gallery/unfollow-artist' && method === 'POST') {
          const id = Number(body?.artistId)
          if (!Number.isFinite(id) || id <= 0) return { status: 400, body: { ok: false, error: '缺少 artistId' } }
          const pixivHome = join(dirname(home), 'pixiv-duty')
          if (!existsSync(pixivHome)) {
            return { status: 400, body: { ok: false, error: '没找到刷 Pixiv 插件的数据目录（$DSH_HOME/pixiv-duty）' } }
          }
          const qf = join(pixivHome, 'unfollow-queue.jsonl')
          const line = JSON.stringify({
            artistId: id,
            artistName: String(body?.artistName || '').slice(0, 80),
            at: new Date().toISOString(),
          })
          try {
            appendFileSync(qf, line + '\n', 'utf8')
          } catch (e) {
            return { status: 500, body: { ok: false, error: '写队列失败：' + (e?.message ?? e) } }
          }
          return { status: 200, body: { ok: true, queued: true } }
        }

        // ── 撤销「排队中」的关注请求：还没真正关注，直接从队列里删掉 ──
        if (path === '/gallery/cancel-follow' && method === 'POST') {
          const id = Number(body?.artistId)
          if (!Number.isFinite(id) || id <= 0) return { status: 400, body: { ok: false, error: '缺少 artistId' } }
          const qf = join(dirname(home), 'pixiv-duty', 'follow-queue.jsonl')
          if (!existsSync(qf)) return { status: 200, body: { ok: true, removed: 0 } }
          let lines = []
          try { lines = readFileSync(qf, 'utf8').split('\n').filter(Boolean) } catch { lines = [] }
          const kept = lines.filter((line) => {
            try { return Number(JSON.parse(line)?.artistId) !== id } catch { return true }
          })
          const removed = lines.length - kept.length
          if (removed) {
            try {
              writeFileSync(qf, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
            } catch (e) {
              return { status: 500, body: { ok: false, error: '写队列失败：' + (e?.message ?? e) } }
            }
          }
          return { status: 200, body: { ok: true, removed } }
        }

        // ── 撤销「取消中」：还没真正取消，从 unfollow-queue 里删掉，恢复成已关注 ──
        if (path === '/gallery/cancel-unfollow' && method === 'POST') {
          const id = Number(body?.artistId)
          if (!Number.isFinite(id) || id <= 0) return { status: 400, body: { ok: false, error: '缺少 artistId' } }
          const qf = join(dirname(home), 'pixiv-duty', 'unfollow-queue.jsonl')
          if (!existsSync(qf)) return { status: 200, body: { ok: true, removed: 0 } }
          let lines = []
          try { lines = readFileSync(qf, 'utf8').split('\n').filter(Boolean) } catch { lines = [] }
          const kept = lines.filter((line) => {
            try { return Number(JSON.parse(line)?.artistId) !== id } catch { return true }
          })
          const removed = lines.length - kept.length
          if (removed) {
            try {
              writeFileSync(qf, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
            } catch (e) {
              return { status: 500, body: { ok: false, error: '写队列失败：' + (e?.message ?? e) } }
            }
          }
          return { status: 200, body: { ok: true, removed } }
        }

        // ── 手动搬动某位画师的全部作品：to='follow' 收进关注图库 / to='out' 移出（回普通或 R-18） ──
        if (path === '/gallery/move-artist' && method === 'POST') {
          const id = Number(body?.artistId)
          if (!Number.isFinite(id) || id <= 0) return { status: 400, body: { ok: false, error: '缺少 artistId' } }
          const to = body?.to === 'out' ? 'out' : 'follow'
          const { cfg, root } = ctxOf()
          const followDir = cfg.followDir || '关注'
          const r = moveArtistWorks(root, cfg.metaDir || '_meta', id, String(body?.artistName || ''), {
            followDir,
            normalDir: cfg.normalDir || '普通插画',
            r18Dir: cfg.r18Dir || 'R-18',
            to,
          })
          // 移出后如果 关注/<画师>/ 空了，顺手把空文件夹收掉
          if (to === 'out' && r.followPath) {
            try {
              if (existsSync(r.followPath) && readdirSync(r.followPath).length === 0) rmdirSync(r.followPath)
            } catch { /* 忽略 */ }
          }
          log(`画师作品${to === 'follow' ? '收进' : '移出'}关注图库：${body?.artistName || id}（${r.moved} 个文件）`)
          return { status: 200, body: { ok: true, moved: r.moved, dirs: r.dirs, to } }
        }

        // ── 统计：图库自己的 + 有抓取插件数据就补充 ──
        if (path === '/stats' && method === 'GET') {
          const { cfg, root } = ctxOf()
          const st = readState(home)
          let items = []
          if (existsSync(root)) {
            try { items = listGallery(root, { metaDir: cfg.metaDir, trashDir: cfg.trashDir, limit: 500, state: st }).items } catch { items = [] }
          }
          let trashCount = 0
          try { trashCount = listTrash({ root, metaDir: cfg.metaDir, trashDir: cfg.trashDir }).length } catch { /* 忽略 */ }
          const pixivHome = join(dirname(home), 'pixiv-duty')
          return { status: 200, body: { ok: true, ...buildStats({ items, trashCount, pixivHome }) } }
        }

        // 写通知：别的插件（比如抓取插件）存完图可以打一下，让面板立刻刷新
        if (path === '/notify' && method === 'POST') {
          notifyListeners()
          return { status: 200, body: { ok: true } }
        }

        return { status: 404, body: { ok: false, error: `没有这个接口：${method} ${path}` } }
      } catch (e) {
        log(`接口 ${path} 失败：${e?.message ?? e}`)
        return { status: 500, body: { ok: false, error: String(e?.message ?? e) } }
      }
    },
  }
}

/** 简单的事件广播：面板连的是轮询，这里只给未来留口子 */
const listeners = new Set()
export function onGalleryChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function notifyListeners() {
  for (const fn of listeners) { try { fn() } catch { /* 忽略 */ } }
}

/** 把图库里的图片安全地吐给浏览器（只读、越界 404） */
async function serveImage(res, { home, rel, log, thumbEdge = 0 }) {
  try {
    const cfg = loadCfg(home)
    const root = resolve(resolveRoot(cfg, home))
    const file = resolve(root, rel)
    if (!(file === root || file.startsWith(root + sep)) || !existsSync(file)) {
      res.statusCode = 404; res.end('not found'); return
    }
    // 图墙走缩略图：原图太大，一屏十几 MB
    let target = file
    if (thumbEdge > 0 && !rel.replace(/\\/g, '/').startsWith('_thumbs/')) {
      try {
        const thumb = await ensureThumb(root, rel, file, { maxEdge: thumbEdge })
        if (thumb && existsSync(thumb)) target = thumb
      } catch { /* 生成失败就退回原图 */ }
    }
    const type = IMG_MIME[extname(target).toLowerCase()]
    if (!type) { res.statusCode = 415; res.end('unsupported'); return }
    res.setHeader('content-type', type)
    res.setHeader('cache-control', 'private, max-age=86400')
    createReadStream(target).on('error', () => { try { res.destroy() } catch { /* 忽略 */ } }).pipe(res)
  } catch (e) {
    log(`图片失败：${e?.message ?? e}`)
    try { res.statusCode = 500; res.end('error') } catch { /* 忽略 */ }
  }
}

function sendNode(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function foreignOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return false
  try { return new URL(origin).host !== String(req.headers.host || '') } catch { return true }
}

export function registerHttp(ctx, { home, log = () => {} }) {
  const api = createApi({ home, log })
  const disposers = []

  // ① 桌面/Web 通用：connection.fetch 精确路由（必须在 /api 下）
  let fetchHost
  try { fetchHost = svc(ctx, 'connection')?.fetch } catch { fetchHost = undefined }
  if (fetchHost?.register) {
    const table = {
      '/ping': ['GET'], '/config': ['GET', 'POST'], '/gallery': ['GET'],
      '/gallery/fav': ['POST'], '/gallery/delete': ['POST'], '/gallery/trash': ['GET'],
      '/gallery/follow-artist': ['POST'], '/gallery/unfollow-artist': ['POST'], '/gallery/cancel-follow': ['POST'], '/gallery/cancel-unfollow': ['POST'], '/gallery/move-artist': ['POST'], '/gallery/restore': ['POST'], '/gallery/purge': ['POST'], '/notify': ['POST'], '/stats': ['GET'],
    }
    for (const [path, methods] of Object.entries(table)) {
      const full = `${API_BASE}${path}`
      try {
        const dispose = fetchHost.register({
          path: full,
          methods,
          requestBody: methods.some((m) => m !== 'GET') ? 'buffered' : 'none',
          fetch: async (request) => {
            try {
              const url = new URL(request.url)
              const isPost = request.method !== 'GET'
              let body
              if (isPost) { try { body = await request.json() } catch { body = {} } }
              const r = await api.handle(request.method, path, url.searchParams, body)
              return new Response(JSON.stringify(r.body), {
                status: r.status,
                headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
              })
            } catch (e) {
              log(`fetch 路由 ${path} 失败：${e?.message ?? e}`)
              return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), {
                status: 500, headers: { 'content-type': 'application/json; charset=utf-8' },
              })
            }
          },
        })
        disposers.push(dispose)
      } catch (e) {
        log(`注册 fetch 路由 ${full} 失败：${e?.message ?? e}`)
      }
    }
  }

  // ② Web / 旧宿主：前缀路由（JSON 接口 + 图片字节）
  if (ctx.webServer?.register) {
    try {
      const dispose = ctx.webServer.register({
        kind: 'prefix',
        path: LEGACY_PREFIX,
        handler: async (req, res) => {
          if (foreignOrigin(req)) { res.statusCode = 403; res.end('forbidden'); return }
          const url = new URL(req.url || '/', 'http://localhost')
          const path = url.pathname.startsWith(LEGACY_PREFIX)
            ? url.pathname.slice(LEGACY_PREFIX.length) || '/'
            : url.pathname
          const method = (req.method || 'GET').toUpperCase()

          if (method === 'GET' && path === '/pic') {
            serveImage(res, { home, rel: url.searchParams.get('p') || '', log, thumbEdge: Number(url.searchParams.get('t') || 0) })
            return
          }

          let body
          if (method === 'POST') {
            body = await new Promise((resolveBody) => {
              let size = 0
              const chunks = []
              req.on('data', (c) => {
                size += c.length
                if (size > MAX_BODY) { resolveBody({}); req.destroy(); return }
                chunks.push(c)
              })
              req.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8')
                try { resolveBody(text ? JSON.parse(text) : {}) } catch { resolveBody({}) }
              })
              req.on('error', () => resolveBody({}))
            })
          }
          const r = await api.handle(method, path, url.searchParams, body)
          sendNode(res, r.status, r.body)
        },
      })
      disposers.push(dispose)
      log(`webServer 前缀路由已挂载 ${LEGACY_PREFIX}`)
    } catch (e) {
      log(`注册 webServer 路由失败：${e?.message ?? e}`)
    }

    // ③ 图片：`<img src>` 用的裸路由（不能走 JSON 层）
    try {
      const dispose = ctx.webServer.register({
        kind: 'prefix',
        path: '/gallery-img',
        handler: async (req, res) => {
          if (foreignOrigin(req)) { res.statusCode = 403; res.end('forbidden'); return }
          if ((req.method || 'GET').toUpperCase() !== 'GET') { res.statusCode = 405; res.end('method'); return }
          const url = new URL(req.url || '/', 'http://localhost')
          serveImage(res, { home, rel: url.searchParams.get('p') || '', log, thumbEdge: Number(url.searchParams.get('t') || 0) })
        },
      })
      disposers.push(dispose)
      log('图片路由已挂载 /gallery-img')
    } catch (e) {
      log(`注册图片路由失败：${e?.message ?? e}`)
    }
  }

  return {
    prefix: API_BASE,
    dispose() { for (const d of disposers) { try { d?.() } catch { /* 忽略 */ } } },
  }
}
