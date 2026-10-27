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
import { existsSync, readdirSync, readFileSync, createReadStream, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, resolve, sep, extname, dirname } from 'node:path'
import { loadCfg, saveCfg, resolveRoot, readState, writeState, rootExists } from './config.mjs'
import { listGallery, trashItem, listTrash, restoreItem, purgeTrash, findMetaFile } from './gallery.mjs'
import { buildStats } from './stats.mjs'

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
function serveImage(res, { home, rel, log }) {
  try {
    const cfg = loadCfg(home)
    const root = resolve(resolveRoot(cfg, home))
    const file = resolve(root, rel)
    if (!(file === root || file.startsWith(root + sep)) || !existsSync(file)) {
      res.statusCode = 404; res.end('not found'); return
    }
    const type = IMG_MIME[extname(file).toLowerCase()]
    if (!type) { res.statusCode = 415; res.end('unsupported'); return }
    res.setHeader('content-type', type)
    res.setHeader('cache-control', 'private, max-age=86400')
    createReadStream(file).on('error', () => { try { res.destroy() } catch { /* 忽略 */ } }).pipe(res)
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
      '/gallery/restore': ['POST'], '/gallery/purge': ['POST'], '/notify': ['POST'], '/stats': ['GET'],
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
            serveImage(res, { home, rel: url.searchParams.get('p') || '', log })
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
          serveImage(res, { home, rel: url.searchParams.get('p') || '', log })
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
