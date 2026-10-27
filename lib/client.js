/**
 * dsh-gallery · 客户端半侧
 * ============================================================================
 * 右上角一个图标 → 展开图库面板：缩略图墙 / 喜好 / 垃圾桶（可还原）/ R18 过滤 /
 * 多图翻页 / 切上一作下一作 / 缩放拖动看图。
 *
 * 数据全部走宿主接口（见 lib/http.mjs），这里不碰文件系统。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-gallery',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const STYLE_ID = 'dsh-gallery'
    const STYLE_VERSION = '1'
    const OPEN_KEY = 'dsh-gallery:open'
    const SIZE_KEY = 'dsh-gallery:size'
    const ONLYFAV_KEY = 'dsh-gallery:onlyfav'
    const R18_KEY = 'dsh-gallery:r18'

    const CANDIDATES = ['/api/gallery', '/gallery/api']
    let BASE = null

    const resolveBase = async () => {
      if (BASE) return BASE
      for (const b of CANDIDATES) {
        try {
          const r = await fetch(`${b}/ping`, { credentials: 'same-origin', signal: AbortSignal.timeout(3000) })
          if (r.ok) { BASE = b; return b }
        } catch { /* 试下一条 */ }
      }
      BASE = CANDIDATES[0]
      return BASE
    }

    const asJson = async (res) => {
      const text = await res.text().catch(() => '')
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { /* 不是 JSON */ }
      if (!res.ok) {
        const detail = data?.error || text.slice(0, 160) || res.statusText
        throw new Error(`HTTP ${res.status}${detail ? '：' + detail : ''}`)
      }
      return data
    }

    const request = async (p, opts = {}) => {
      const b = await resolveBase()
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 15000)
      try {
        const res = await fetch(b + p, { credentials: 'same-origin', ...opts, signal: ctl.signal })
        return await asJson(res)
      } catch (e) {
        if (e?.name === 'AbortError') throw new Error('请求超时（15 秒）—— 插件后端没响应')
        throw e
      } finally { clearTimeout(timer) }
    }
    const jget = (p) => request(p)
    const jpost = (p, body) => request(p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })

    /** 图片地址（裸 HTTP 路由，`<img src>` 用） */
    const imgUrl = (rel) => `/gallery-img?p=${encodeURIComponent(rel)}`

    function ensureStyle() {
      const existing = document.querySelector(`style[data-plugin="${STYLE_ID}"]`)
      if (existing !== null && existing.dataset.version === STYLE_VERSION) return
      if (existing !== null) existing.remove()
      const style = document.createElement('style')
      style.dataset.plugin = STYLE_ID
      style.dataset.version = STYLE_VERSION
      style.textContent = `
.gxg-launch{position:fixed;z-index:1200;right:18px;top:118px;width:48px;height:48px;border-radius:24px;border:1px solid var(--dsw-alias-border-l2,rgba(128,140,160,.22));background:var(--dsw-alias-bg-layer-1,#1b1d22);color:var(--dsw-alias-label-primary,#e8ecf4);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35);padding:0}
.gxg-launch:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,140,160,.14))}
.gxg-launch[data-open="true"]{display:none}
.gxg-panel{position:fixed;z-index:1199;right:18px;top:118px;width:560px;height:640px;display:none;flex-direction:column;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(128,140,160,.22));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1b1d22);color:var(--dsw-alias-label-primary,#e8ecf4);box-shadow:0 16px 40px rgba(0,0,0,.42);font:13px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;overflow:hidden}
.gxg-panel[data-open="true"]{display:flex}
.gxg-head{flex:none;display:flex;align-items:center;gap:6px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,140,160,.16));user-select:none}
.gxg-title{flex:1;min-width:0;font-size:14px;color:var(--dsw-alias-label-secondary,#93a0b5);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxg-tool{width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#93a0b5);cursor:pointer;padding:0;font-size:17px;line-height:1}
.gxg-tool:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,140,160,.16))}
.gxg-tool[data-on="true"]{color:#ff6b8a;background:var(--dsw-alias-interactive-bg-hover,rgba(128,140,160,.16))}
.gxg-tool:disabled{opacity:.35;cursor:default}
.gxg-body{flex:1;min-height:0;overflow:auto;padding:8px}
.gxg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.gxg-cellwrap{position:relative}
.gxg-cell{position:relative;display:block;width:100%;box-sizing:border-box;padding:0;border:0;border-radius:8px;overflow:hidden;background:rgba(128,128,128,.12);cursor:pointer;aspect-ratio:3/4}
.gxg-cell img{width:100%;height:100%;object-fit:cover;display:block}
.gxg-cell[data-r18="true"]::after{content:'R-18';position:absolute;left:4px;top:4px;font-size:9px;padding:1px 4px;border-radius:4px;background:rgba(190,40,60,.85);color:#fff}
.gxg-cell-tools{position:absolute;right:4px;top:4px;z-index:2;display:flex;gap:4px;opacity:0;transition:opacity .15s ease}
.gxg-cellwrap:hover .gxg-cell-tools,.gxg-cellwrap[data-fav="true"] .gxg-cell-tools,.gxg-cell-tools:focus-within{opacity:1}
.gxg-mini{width:26px;height:26px;border:0;border-radius:13px;padding:0;display:grid;place-items:center;font:14px/1 "Segoe UI",system-ui,sans-serif;cursor:pointer;background:rgba(20,22,28,.78);color:#e8ecf4;box-shadow:0 2px 8px rgba(0,0,0,.35)}
.gxg-mini:hover{background:rgba(46,52,64,.95)}
.gxg-mini[data-act="fav"][data-on="true"]{color:#ff6b8a}
.gxg-menu{position:fixed;z-index:1300;min-width:140px;padding:4px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1b1d22);border:1px solid var(--dsw-alias-border-l2,rgba(128,140,160,.22));box-shadow:0 12px 28px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:2px}
.gxg-menu button{border:0;background:transparent;color:var(--dsw-alias-label-primary,#e8ecf4);text-align:left;font:12px/1.6 inherit;padding:6px 8px;border-radius:6px;cursor:pointer}
.gxg-menu button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,140,160,.16))}
.gxg-empty{color:var(--dsw-alias-label-tertiary,#8a9099);text-align:center;padding:30px 10px;font-size:12px;line-height:1.8;white-space:pre-line}
.gxg-group{display:flex;align-items:baseline;gap:6px;padding:8px 2px 4px;user-select:none}
.gxg-group:first-child{padding-top:0}
.gxg-group-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#e8ecf4)}
.gxg-group-count{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9099)}
.gxg-view{display:flex;flex-direction:column;height:100%;position:relative}
.gxg-viewbar{flex:none;display:flex;align-items:center;gap:5px;padding-bottom:8px}
.gxg-vlabel{min-width:58px;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary,#8a9099);user-select:none}
.gxg-imgwrap{position:relative;flex:1;min-height:0;display:flex}
.gxg-viewimgbox{flex:1;min-height:0;overflow:auto;display:flex;background:rgba(0,0,0,.3);border-radius:8px;cursor:grab}
.gxg-viewimgbox[data-panning="true"]{cursor:grabbing}
.gxg-viewimgbox img{display:block;flex:0 0 auto;margin:auto;transform-origin:center center}
.gxg-viewimgbox[data-fit="true"] img{max-width:100%;max-height:100%;width:auto;height:auto}
.gxg-viewimgbox[data-fit="false"] img{max-width:none;max-height:none}
.gxg-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:4;width:36px;height:64px;border:0;border-radius:10px;padding:0;display:grid;place-items:center;font:26px/1 "Segoe UI",system-ui,sans-serif;color:#e8ecf4;background:rgba(20,22,28,.55);box-shadow:0 6px 18px rgba(0,0,0,.35);cursor:pointer;opacity:.28;transition:opacity .16s ease,background .16s ease}
.gxg-view:hover .gxg-nav{opacity:1}
.gxg-nav:hover{background:rgba(46,52,64,.92)}
.gxg-nav.prev{left:4px}
.gxg-nav.next{right:4px}
.gxg-nav:disabled{display:none}
.gxg-pager-float{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);z-index:3;display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:14px;background:rgba(18,20,26,.72);box-shadow:0 6px 18px rgba(0,0,0,.4);opacity:.32;transition:opacity .16s ease}
.gxg-view:hover .gxg-pager-float{opacity:1}
.gxg-pager-float .gxg-tool{width:38px;height:34px;font-size:22px;color:#e8ecf4}
.gxg-pager-float .gxg-vlabel{color:#e8ecf4;min-width:70px;font-size:14px}
.gxg-cap{flex:none;padding-top:6px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a9099);white-space:pre-wrap;word-break:break-word;max-height:66px;overflow:auto}
.gxg-toast{position:absolute;left:10px;right:10px;bottom:10px;z-index:6;padding:7px 11px;border-radius:8px;background:rgba(18,20,26,.92);color:var(--dsw-alias-label-primary,#e8ecf4);font-size:12px;line-height:1.5;opacity:0;transform:translateY(6px);transition:opacity .16s ease,transform .16s ease;pointer-events:none;box-shadow:0 8px 22px rgba(0,0,0,.4)}
.gxg-toast[data-show="true"]{opacity:1;transform:none}
.gxg-toast[data-action="true"]{pointer-events:auto;display:flex;align-items:center;gap:8px}
.gxg-toast[data-action="true"] span{flex:1;min-width:0}
.gxg-toast button{flex:none;border:0;border-radius:6px;background:rgba(255,255,255,.16);color:#fff;font:11px/1 inherit;padding:4px 8px;cursor:pointer}
.gxg-trash{display:flex;flex-direction:column;gap:2px}
.gxg-trash-bar{display:flex;align-items:center;justify-content:space-between;padding:2px 2px 6px;color:var(--dsw-alias-label-secondary,#93a0b5);font-size:11px}
.gxg-trash-row{display:flex;align-items:center;gap:8px;padding:6px;border-radius:8px;background:rgba(128,140,160,.06)}
.gxg-trash-row:hover{background:rgba(128,140,160,.13)}
.gxg-trash-thumb{width:44px;height:44px;object-fit:cover;border-radius:6px;flex:none;background:rgba(0,0,0,.25)}
.gxg-trash-info{flex:1;min-width:0}
.gxg-trash-name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxg-trash-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9099);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gxg-trash-acts{display:flex;gap:4px;flex:none}
.gxg-link{border:0;background:transparent;color:var(--dsw-alias-state-business-primary,#679efe);font:11px/1 inherit;cursor:pointer;padding:4px 6px;border-radius:6px}
.gxg-link:hover{background:rgba(128,140,160,.16)}
.gxg-danger{color:#ff6b6b}
.gxg-edge{position:absolute;z-index:3}
.gxg-edge.w{left:0;top:10px;bottom:10px;width:6px;cursor:ew-resize}
.gxg-edge.e{right:0;top:10px;bottom:10px;width:6px;cursor:ew-resize}
.gxg-edge.n{top:0;left:10px;right:10px;height:6px;cursor:ns-resize}
.gxg-edge.s{bottom:0;left:10px;right:10px;height:6px;cursor:ns-resize}
.gxg-edge.nw{left:0;top:0;width:16px;height:16px;cursor:nwse-resize}
.gxg-edge.ne{right:0;top:0;width:16px;height:16px;cursor:nesw-resize}
.gxg-edge.sw{left:0;bottom:0;width:16px;height:16px;cursor:nesw-resize}
.gxg-edge.se{right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize}
.gxg-stats{display:flex;flex-direction:column;gap:10px;padding:2px 2px 8px}
.gxg-stats-day{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#e8ecf4)}
.gxg-stats-block{border-radius:10px;background:rgba(128,140,160,.07);padding:8px 10px;display:flex;flex-direction:column;gap:5px}
.gxg-stats-title{font-size:12px;color:var(--dsw-alias-label-secondary,#93a0b5);margin-bottom:2px}
.gxg-stats-row{display:flex;align-items:center;gap:8px;font-size:12px}
.gxg-stats-k{flex:none;min-width:76px;color:var(--dsw-alias-label-tertiary,#8a9099)}
.gxg-stats-v{color:var(--dsw-alias-label-primary,#e8ecf4)}
.gxg-chips{display:flex;flex-wrap:wrap;gap:6px}
.gxg-chip{border-radius:999px;background:rgba(103,158,254,.16);color:#9dc0ff;font-size:11px;padding:3px 9px;line-height:1.4}
.gxg-bar{flex:1;height:8px;border-radius:4px;background:rgba(128,140,160,.15);overflow:hidden}
.gxg-bar i{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,#679efe,#8f7bff)}
.gxg-stats-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a9099);line-height:1.6}
.gxg-badge{position:absolute;display:flex;align-items:center;gap:6px;z-index:3;padding:4px 8px;border-radius:9px;background:rgba(14,16,22,.62);backdrop-filter:blur(2px);font-size:12px;line-height:1.4;opacity:.55;transition:opacity .16s ease;user-select:text;max-width:calc(100% - 20px)}
.gxg-view:hover .gxg-badge{opacity:1}
.gxg-badge-item{cursor:pointer;border-radius:5px;padding:1px 5px;color:#e8ecf4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px}
.gxg-badge-item:hover{background:rgba(255,255,255,.16)}
.gxg-badge-item[data-disabled="true"]{cursor:default;color:#8a9099}
.gxg-badge-item[data-disabled="true"]:hover{background:transparent}
.gxg-badge-id{color:#9dc0ff;font-variant-numeric:tabular-nums}
`
      document.head.append(style)
    }

    // 相册：相框 + 山 + 太阳（36px，跟 80px 的按钮配）
    const ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M3.5 17.5l5.5-5.5 4.5 4.5 3-3 4 4"/></svg>'

    /** 装上图库：右上角小图标 ↔ 面板 ↔ 单图查看 */
    function installGallery() {
      if (document.querySelector('.gxg-panel') !== null) return null
      ensureStyle()

      const launcher = document.createElement('button')
      launcher.type = 'button'
      launcher.className = 'gxg-launch'
      launcher.title = '图库'
      launcher.innerHTML = ICON

      const panel = document.createElement('div')
      panel.className = 'gxg-panel'

      const head = document.createElement('div')
      head.className = 'gxg-head'
      const title = document.createElement('span')
      title.className = 'gxg-title'
      title.textContent = '图库'

      const mkTool = (label, tip, onClick) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'gxg-tool'
        b.textContent = label
        b.title = tip
        b.addEventListener('click', (event) => { event.stopPropagation(); onClick() })
        return b
      }

      const favFilter = mkTool('♥', '只看喜好', () => {
        onlyFav = !onlyFav
        try { window.localStorage.setItem(ONLYFAV_KEY, onlyFav ? '1' : '0') } catch { /* 忽略 */ }
        syncHead()
        if (viewingTrash) void renderTrash()
        else renderGrid()
      })
      const r18Hide = mkTool('⊘', '隐藏 R18', () => setR18Mode(r18Mode === 'hide' ? 'all' : 'hide'))
      const r18Only = mkTool('18+', '只看 R18', () => setR18Mode(r18Mode === 'only' ? 'all' : 'only'))
      r18Only.style.fontSize = '12px'
      const trashBtn = mkTool('🗑', '垃圾桶', () => {
        viewingTrash = !viewingTrash
        viewingStats = false
        syncHead()
        if (viewingTrash) void renderTrash()
        else renderGrid()
      })
      const statsBtn = mkTool('📊', '今天的统计', () => {
        viewingStats = !viewingStats
        syncHead()
        if (viewingStats) void renderStats()
        else if (viewingTrash) void renderTrash()
        else renderGrid()
      })
      const refreshBtn = mkTool('⟳', '刷新', () => { void load(true) })
      const closeBtn = mkTool('—', '收起', () => setOpen(false))

      head.append(title, favFilter, r18Hide, r18Only, trashBtn, statsBtn, refreshBtn, closeBtn)

      const body = document.createElement('div')
      body.className = 'gxg-body'
      panel.append(head, body)

      // 尺寸记忆
      try {
        const saved = JSON.parse(window.localStorage.getItem(SIZE_KEY) ?? 'null')
        if (saved && Number(saved.w) > 0 && Number(saved.h) > 0) {
          panel.style.width = `${Math.max(320, Math.min(window.innerWidth - 24, Number(saved.w)))}px`
          panel.style.height = `${Math.max(260, Math.min(window.innerHeight - 24, Number(saved.h)))}px`
        }
      } catch { /* 忽略 */ }

      let items = []
      let cfg = null
      let onlyFav = (() => { try { return window.localStorage.getItem(ONLYFAV_KEY) === '1' } catch { return false } })()
      let r18Mode = (() => {
        try { const v = window.localStorage.getItem(R18_KEY); return v === 'hide' || v === 'only' ? v : 'all' } catch { return 'all' }
      })()
      let viewingTrash = false
      let viewingStats = false
      let visibleItems = []
      let view = null
      let dragPan = null
      let dragResize = null
      let menu = null
      let toastEl = null
      let toastTimer = 0
      let pollTimer = 0

      const isR18 = (it) => Boolean(it.rating) && it.rating !== 'all'

      function syncHead() {
        favFilter.dataset.on = String(onlyFav)
        favFilter.title = onlyFav ? '显示全部' : '只看喜好'
        r18Hide.dataset.on = String(r18Mode === 'hide')
        r18Hide.title = r18Mode === 'hide' ? '不隐藏 R18' : '隐藏 R18'
        r18Only.dataset.on = String(r18Mode === 'only')
        r18Only.title = r18Mode === 'only' ? '显示全部' : '只看 R18'
        trashBtn.dataset.on = String(viewingTrash)
        trashBtn.title = viewingTrash ? '回到图库' : '垃圾桶'
        statsBtn.dataset.on = String(viewingStats)
        statsBtn.title = viewingStats ? '回到图库' : '今天的统计'
      }

      function setR18Mode(mode) {
        r18Mode = mode
        try { window.localStorage.setItem(R18_KEY, mode) } catch { /* 忽略 */ }
        syncHead()
        if (viewingTrash) void renderTrash()
        else renderGrid()
      }

      function setOpen(open) {
        panel.dataset.open = open ? 'true' : 'false'
        launcher.dataset.open = open ? 'true' : 'false'
        if (!open) closeMenu()
        try { window.localStorage.setItem(OPEN_KEY, open ? '1' : '0') } catch { /* 忽略 */ }
        if (open) void load(false)
      }

      launcher.addEventListener('click', () => setOpen(true))

      function toast(text, action) {
        if (toastEl === null) {
          toastEl = document.createElement('div')
          toastEl.className = 'gxg-toast'
          panel.append(toastEl)
        }
        toastEl.textContent = ''
        toastEl.dataset.action = action ? 'true' : 'false'
        const span = document.createElement('span')
        span.textContent = text
        toastEl.append(span)
        if (action) {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.textContent = action.label
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation()
            toastEl.dataset.show = 'false'
            action.run()
          })
          toastEl.append(btn)
        }
        toastEl.dataset.show = 'true'
        window.clearTimeout(toastTimer)
        toastTimer = window.setTimeout(() => { if (toastEl !== null) toastEl.dataset.show = 'false' }, action ? 6000 : 2800)
      }


      /** 复制到剪贴板（老浏览器退回 execCommand） */
      async function copyText(text) {
        try {
          if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true }
        } catch { /* 退回 */ }
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.append(ta)
          ta.select()
          const ok = document.execCommand('copy')
          ta.remove()
          return ok
        } catch { return false }
      }
      /* ── 右键菜单 ── */
      function closeMenu() {
        if (menu !== null) { menu.remove(); menu = null }
      }
      function openMenu(event, item) {
        closeMenu()
        menu = document.createElement('div')
        menu.className = 'gxg-menu'
        const row = (text, onClick) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.textContent = text
          b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick() })
          return b
        }
        menu.append(
          row(item.fav ? '♥ 取消喜好' : '♥ 标记为喜好', () => { closeMenu(); void toggleFav(item) }),
          row('🗑 移入垃圾桶', () => { closeMenu(); void deleteItem(item) }),
        )
        menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - 160))}px`
        menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - 100))}px`
        document.body.append(menu)
        window.setTimeout(() => {
          const off = (ev) => {
            if (menu !== null && !menu.contains(ev.target)) { closeMenu(); window.removeEventListener('mousedown', off, true) }
          }
          window.addEventListener('mousedown', off, true)
        }, 0)
      }

      /* ── 喜好 / 删除 ── */
      function paintFav(key, fav) {
        for (const el of panel.querySelectorAll(`[data-key="${key}"][data-act="fav"]`)) {
          el.dataset.on = String(fav)
          el.title = fav ? '取消喜好' : '标记为喜好'
        }
        for (const el of panel.querySelectorAll(`[data-key="${key}"][data-role="cell"]`)) el.dataset.fav = String(fav)
      }

      async function toggleFav(item) {
        const next = item.fav !== true
        item.fav = next
        paintFav(item.key, next)
        try {
          await jpost('/gallery/fav', { key: item.key, fav: next })
          toast(next ? '已标记为喜好' : '已取消喜好')
          if (onlyFav && !next && !viewingTrash) {
            items = items.filter((x) => x.key !== item.key)
            const keep = body.scrollTop
            renderGrid()
            body.scrollTop = keep
          }
        } catch (e) {
          item.fav = !next
          paintFav(item.key, !next)
          toast(`喜好没存上：${e?.message ?? e}`)
        }
      }

      async function deleteItem(item) {
        closeMenu()
        try {
          const r = await jpost('/gallery/delete', { key: item.key })
          items = items.filter((x) => x.key !== item.key)
          view = null
          const keep = body.scrollTop
          renderGrid()
          body.scrollTop = keep
          const miss = Array.isArray(r?.missing) ? r.missing.length : 0
          toast(`已移入垃圾桶：${item.title || ''}${miss ? `（${miss} 个文件本来就不在）` : ''}`, {
            label: '撤销',
            run: () => { void restoreItem(r?.bin) },
          })
        } catch (e) {
          toast(`删除失败：${e?.message ?? e}`)
        }
      }

      async function restoreItem(bin) {
        try {
          const r = await jpost('/gallery/restore', { bin })
          toast(`已还原（${r?.restored?.length ?? 0} 个文件）`)
          void load(false)
        } catch (e) {
          toast(`还原失败：${e?.message ?? e}`)
        }
      }

      async function purgeItem(target) {
        try {
          const r = await jpost('/gallery/purge', target)
          toast(`已彻底删除 ${r?.purged?.length ?? 0} 件`)
          if (viewingTrash) void renderTrash()
        } catch (e) {
          toast(`彻底删除失败：${e?.message ?? e}`)
        }
      }

      /* ── 列表 ── */
      async function loadConfig() {
        try {
          const r = await jget('/config')
          cfg = r?.cfg || null
          title.textContent = cfg?.title || '图库'
          launcher.title = cfg?.title || '图库'
        } catch (e) {
          title.textContent = '图库（连不上后端）'
        }
      }

      async function load(manual) {
        if (manual) title.textContent = '刷新中…'
        if (!cfg) await loadConfig()
        try {
          const data = await jget('/gallery?limit=500')
          items = Array.isArray(data.items) ? data.items : []
          cfg = cfg || {}
          cfg.exists = data.exists !== false
          cfg.root = data.root || cfg.root
          title.textContent = `${cfg.title || '图库'} · ${items.length} 件`
          if (viewingStats) void renderStats()
          else if (viewingTrash) void renderTrash()
          else renderGrid()
        } catch (e) {
          title.textContent = '图库 · 读取失败'
          body.textContent = ''
          const empty = document.createElement('div')
          empty.className = 'gxg-empty'
          empty.textContent = `读不到图库：${e?.message ?? e}`
          body.append(empty)
        }
      }

      function dayInfo(savedAt) {
        const d = savedAt ? new Date(savedAt) : null
        const ok = d && !Number.isNaN(d.getTime())
        const local = ok ? d : new Date()
        const key = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
        const md = `${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
        const t0 = new Date()
        const todayKey = `${t0.getFullYear()}-${String(t0.getMonth() + 1).padStart(2, '0')}-${String(t0.getDate()).padStart(2, '0')}`
        const y = new Date(t0); y.setDate(t0.getDate() - 1)
        const yesterdayKey = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
        const label = key === todayKey ? `今天 · ${md}` : key === yesterdayKey ? `昨天 · ${md}` : (ok ? md : '日期未知')
        return { key, label, ts: ok ? d.getTime() : 0 }
      }

      function renderGrid() {
        view = null
        closeMenu()
        body.textContent = ''
        if (items.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'gxg-empty'
          empty.textContent = cfg?.exists === false
            ? '图库目录还不存在。\n去「设置 → 图库」填一个文件夹，或者把图片放进去。'
            : '这个图库里还没有图片。'
          body.append(empty)
          return
        }
        let visible = items
        if (onlyFav) visible = visible.filter((it) => it.fav === true)
        if (r18Mode === 'hide') visible = visible.filter((it) => !isR18(it))
        if (r18Mode === 'only') visible = visible.filter(isR18)
        visibleItems = visible
        if (visible.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'gxg-empty'
          empty.textContent = '当前筛选下没有作品。\n点标题栏的 ♥ / ⊘ / 18+ 可以放宽条件。'
          body.append(empty)
          return
        }

        const groups = new Map()
        visible.forEach((item) => {
          const info = dayInfo(item.savedAt)
          if (!groups.has(info.key)) groups.set(info.key, { label: info.label, ts: info.ts, rows: [] })
          groups.get(info.key).rows.push({ item })
        })
        const ordered = [...groups.entries()].sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))

        for (const [, g] of ordered) {
          const groupHead = document.createElement('div')
          groupHead.className = 'gxg-group'
          const name = document.createElement('span')
          name.className = 'gxg-group-name'
          name.textContent = g.label
          const count = document.createElement('span')
          count.className = 'gxg-group-count'
          count.textContent = `${g.rows.length} 件`
          groupHead.append(name, count)
          body.append(groupHead)

          const grid = document.createElement('div')
          grid.className = 'gxg-grid'
          for (const { item } of g.rows) {
            const cell = document.createElement('button')
            cell.type = 'button'
            cell.className = 'gxg-cell'
            cell.dataset.key = item.key
            cell.dataset.role = 'cell'
            cell.dataset.fav = String(item.fav === true)
            if (isR18(item)) cell.dataset.r18 = 'true'
            cell.title = [item.title, item.artist, `${item.pages} 页`].filter(Boolean).join('\n')
            const img = document.createElement('img')
            img.loading = 'lazy'
            img.decoding = 'async'
            img.alt = item.title || 'image'
            img.src = imgUrl(item.thumb)
            cell.append(img)
            cell.addEventListener('click', () => openViewer(item))
            cell.addEventListener('contextmenu', (event) => { event.preventDefault(); openMenu(event, item) })

            const wrap = document.createElement('div')
            wrap.className = 'gxg-cellwrap'
            wrap.dataset.key = item.key
            wrap.dataset.role = 'cell'
            wrap.dataset.fav = String(item.fav === true)
            wrap.append(cell)

            const tools = document.createElement('div')
            tools.className = 'gxg-cell-tools'
            const favBtn = document.createElement('button')
            favBtn.type = 'button'
            favBtn.className = 'gxg-mini'
            favBtn.dataset.key = item.key
            favBtn.dataset.act = 'fav'
            favBtn.dataset.on = String(item.fav === true)
            favBtn.textContent = '♥'
            favBtn.title = item.fav ? '取消喜好' : '标记为喜好'
            favBtn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void toggleFav(item) })

            const delBtn = document.createElement('button')
            delBtn.type = 'button'
            delBtn.className = 'gxg-mini'
            delBtn.dataset.key = item.key
            delBtn.dataset.act = 'del'
            delBtn.textContent = '🗑'
            delBtn.title = '移入垃圾桶（可撤销）'
            delBtn.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); void deleteItem(item) })

            tools.append(favBtn, delBtn)
            wrap.append(tools)
            grid.append(wrap)
          }
          body.append(grid)
        }
      }

      /* ── 垃圾桶 ── */
      async function renderTrash() {
        view = null
        closeMenu()
        body.textContent = ''
        const wrap = document.createElement('div')
        wrap.className = 'gxg-trash'
        body.append(wrap)

        let data = null
        try { data = await jget('/gallery/trash') } catch (e) {
          const err = document.createElement('div')
          err.className = 'gxg-empty'
          err.textContent = `读不到垃圾桶：${e?.message ?? e}`
          wrap.append(err)
          return
        }
        const list = Array.isArray(data?.items) ? data.items : []
        const bar = document.createElement('div')
        bar.className = 'gxg-trash-bar'
        const count = document.createElement('span')
        count.textContent = `垃圾桶 · ${list.length} 件`
        bar.append(count)
        if (list.length) {
          const clear = document.createElement('button')
          clear.type = 'button'
          clear.className = 'gxg-link'
          clear.textContent = '清空'
          clear.addEventListener('click', () => { void purgeItem({ all: true }) })
          bar.append(clear)
        }
        wrap.append(bar)

        if (!list.length) {
          const empty = document.createElement('div')
          empty.className = 'gxg-empty'
          empty.textContent = '垃圾桶是空的。\n删掉的东西会先来这里，能还原。'
          wrap.append(empty)
          return
        }

        for (const t of list) {
          const row = document.createElement('div')
          row.className = 'gxg-trash-row'

          const thumb = document.createElement('img')
          thumb.className = 'gxg-trash-thumb'
          thumb.loading = 'lazy'
          if (t.thumb) thumb.src = imgUrl(t.thumb)

          const info = document.createElement('div')
          info.className = 'gxg-trash-info'
          const nm = document.createElement('div')
          nm.className = 'gxg-trash-name'
          nm.textContent = t.title || t.bin
          const meta = document.createElement('div')
          meta.className = 'gxg-trash-meta'
          const when = String(t.deletedAt || '').replace('T', ' ').slice(0, 16)
          meta.textContent = [t.artist, `${t.pages} 个文件`, when].filter(Boolean).join(' · ')
          info.append(nm, meta)

          const acts = document.createElement('div')
          acts.className = 'gxg-trash-acts'
          const undo = document.createElement('button')
          undo.type = 'button'
          undo.className = 'gxg-link'
          undo.textContent = '还原'
          undo.addEventListener('click', () => { void restoreItem(t.bin) })
          const purge = document.createElement('button')
          purge.type = 'button'
          purge.className = 'gxg-link gxg-danger'
          purge.textContent = '彻底删除'
          purge.addEventListener('click', () => { void purgeItem({ bin: t.bin }) })
          acts.append(undo, purge)

          row.append(thumb, info, acts)
          wrap.append(row)
        }
      }

      /* ── 今天的统计 ── */
      async function renderStats() {
        view = null
        closeMenu()
        body.textContent = ''
        const wrap = document.createElement('div')
        wrap.className = 'gxg-stats'
        body.append(wrap)

        let data = null
        try { data = await jget('/stats') } catch (e) {
          const err = document.createElement('div')
          err.className = 'gxg-empty'
          err.textContent = `读不到统计：${e?.message ?? e}`
          wrap.append(err)
          return
        }

        const g = data.gallery || {}
        const p = data.pixiv
        const head = document.createElement('div')
        head.className = 'gxg-stats-day'
        head.textContent = `今天 · ${data.day || ''}`
        wrap.append(head)

        const block = (name, rows) => {
          const box = document.createElement('div')
          box.className = 'gxg-stats-block'
          const h = document.createElement('div')
          h.className = 'gxg-stats-title'
          h.textContent = name
          box.append(h)
          for (const [k, v] of rows) {
            const line = document.createElement('div')
            line.className = 'gxg-stats-row'
            const kk = document.createElement('span')
            kk.className = 'gxg-stats-k'
            kk.textContent = k
            const vv = document.createElement('span')
            vv.className = 'gxg-stats-v'
            vv.textContent = v
            line.append(kk, vv)
            box.append(line)
          }
          return box
        }

        const chips = (name, list) => {
          const box = document.createElement('div')
          box.className = 'gxg-stats-block'
          const h = document.createElement('div')
          h.className = 'gxg-stats-title'
          h.textContent = name
          box.append(h)
          const row = document.createElement('div')
          row.className = 'gxg-chips'
          if (!list || !list.length) {
            const e = document.createElement('span')
            e.className = 'gxg-stats-v'
            e.textContent = '（无）'
            row.append(e)
          } else {
            for (const it of list) {
              const c = document.createElement('span')
              c.className = 'gxg-chip'
              c.textContent = `${it.k} · ${it.v}`
              row.append(c)
            }
          }
          box.append(row)
          return box
        }

        wrap.append(block('图库', [
          ['总数', `${g.total ?? 0} 件`],
          ['今天新增', `${g.todayAdded ?? 0} 件`],
          ['昨天新增', `${g.yesterdayAdded ?? 0} 件`],
          ['喜好', `${g.favs ?? 0} 件`],
          ['R18', `${g.r18 ?? 0} 件`],
          ['多页', `${g.multiPage ?? 0} 件（共 ${g.pages ?? 0} 页）`],
          ['垃圾桶', `${g.trash ?? 0} 件`],
        ]))

        if (p) {
          const tokens = Number(p.tokens) || 0
          wrap.append(block('抓取（今天）', [
            ['轮次', `${p.roundCount ?? 0} 轮`],
            ['存下', `${p.saved ?? 0} 件（R18 ${p.ratings?.r18 ?? 0} / 一般 ${p.ratings?.all ?? 0}）`],
            ['跳过', p.skipped === null ? '（没有日报）' : `${p.skipped} 件`],
            ['token', tokens ? `${(tokens / 1000).toFixed(0)}k` : '（无记账）'],
            ['花费', p.costCNY ? `¥${Number(p.costCNY).toFixed(3)}` : '—'],
          ]))
          if (p.keywords && p.keywords.length) wrap.append(chips('关键词命中', p.keywords))
          if (p.reasons && p.reasons.length) wrap.append(chips('跳过原因', p.reasons))

          if (p.rounds && p.rounds.length) {
            const box = document.createElement('div')
            box.className = 'gxg-stats-block'
            const h = document.createElement('div')
            h.className = 'gxg-stats-title'
            h.textContent = '今天各轮'
            box.append(h)
            for (const r of p.rounds) {
              const line = document.createElement('div')
              line.className = 'gxg-stats-row'
              const when = String(r.at || '').replace('T', ' ').slice(11, 16)
              const kk = document.createElement('span')
              kk.className = 'gxg-stats-k'
              kk.textContent = when || '—'
              const vv = document.createElement('span')
              vv.className = 'gxg-stats-v'
              vv.textContent = [
                `${r.saved ?? 0} 件`,
                r.tokens ? `${(Number(r.tokens) / 1000).toFixed(0)}k` : '无记账',
                r.costCNY ? `¥${Number(r.costCNY).toFixed(3)}` : '',
              ].filter(Boolean).join(' · ')
              line.append(kk, vv)
              box.append(line)
            }
            wrap.append(box)
          }
        } else {
          const tip = document.createElement('div')
          tip.className = 'gxg-stats-hint'
          tip.textContent = '没找到抓取插件的数据（$DSH_HOME/pixiv-duty），只显示图库自己的统计。'
          wrap.append(tip)
        }

        if (data.days && data.days.length) {
          const box = document.createElement('div')
          box.className = 'gxg-stats-block'
          const h = document.createElement('div')
          h.className = 'gxg-stats-title'
          h.textContent = '近 7 天收集'
          box.append(h)
          const max = Math.max(...data.days.map((d) => d.count), 1)
          for (const d of data.days) {
            const line = document.createElement('div')
            line.className = 'gxg-stats-row'
            const kk = document.createElement('span')
            kk.className = 'gxg-stats-k'
            kk.textContent = d.day.slice(5)
            const bar = document.createElement('span')
            bar.className = 'gxg-bar'
            const fill = document.createElement('i')
            fill.style.width = `${Math.max(6, Math.round((d.count / max) * 100))}%`
            bar.append(fill)
            const vv = document.createElement('span')
            vv.className = 'gxg-stats-v'
            vv.textContent = `${d.count}`
            line.append(kk, bar, vv)
            box.append(line)
          }
          wrap.append(box)
        }
      }
      /* ── 单图查看 ── */
      function openViewer(item) {
        if (!item) return
        body.textContent = ''
        const pos = visibleItems.findIndex((x) => x.key === item.key)
        view = { index: pos, fit: true, scale: 1, box: null }

        const wrap = document.createElement('div')
        wrap.className = 'gxg-view'

        const bar = document.createElement('div')
        bar.className = 'gxg-viewbar'
        const back = mkTool('←', '回到列表', renderGrid)
        const zoomOut = mkTool('−', '缩小', () => zoomBy(1 / 1.25, label, true))
        const zoomIn = mkTool('+', '放大', () => zoomBy(1.25, label, true))
        const label = document.createElement('span')
        label.className = 'gxg-vlabel'
        label.textContent = '适应'
        const fit = mkTool('⤢', '适应窗口', () => { view.fit = true; applyZoom(label) })
        const actual = mkTool('1:1', '实际大小', () => { view.fit = false; view.scale = 1; applyZoom(label); centerScroll() })

        const favBtn = mkTool('♥', item.fav ? '取消喜好' : '标记为喜好', () => { void toggleFav(item) })
        favBtn.dataset.key = item.key
        favBtn.dataset.act = 'fav'
        favBtn.dataset.on = String(item.fav === true)
        const delBtn = mkTool('🗑', '移入垃圾桶（可撤销）', () => { void deleteItem(item) })
        bar.append(back, zoomOut, label, zoomIn, fit, actual, favBtn, delBtn)

        const box = document.createElement('div')
        box.className = 'gxg-viewimgbox'
        box.dataset.fit = 'true'
        view.box = box
        const img = document.createElement('img')
        img.draggable = false
        img.alt = item.title || 'image'
        img.onload = () => { applyZoom(label); positionBadge() }
        box.append(img)

        const pages = Array.isArray(item.files) && item.files.length ? item.files.slice() : [item.thumb]
        let pageNo = 0
        const pageLabel = document.createElement('span')
        pageLabel.className = 'gxg-vlabel'
        const prevPage = mkTool('‹', '上一页', () => showPage(pageNo - 1))
        const nextPage = mkTool('›', '下一页', () => showPage(pageNo + 1))
        const pager = document.createElement('div')
        pager.className = 'gxg-pager-float'
        pager.append(prevPage, pageLabel, nextPage)

        function showPage(n) {
          if (!pages.length) return
          pageNo = Math.max(0, Math.min(pages.length - 1, n))
          pageLabel.textContent = `${pageNo + 1} / ${pages.length}`
          prevPage.disabled = pageNo === 0
          nextPage.disabled = pageNo === pages.length - 1
          img.src = imgUrl(pages[pageNo])
          box.scrollTop = 0
          box.scrollLeft = 0
        }
        showPage(0)

        box.addEventListener('wheel', (event) => {
          event.preventDefault()
          const before = img.getBoundingClientRect()
          if (before.width <= 0 || before.height <= 0) return
          const rx = (event.clientX - before.left) / before.width
          const ry = (event.clientY - before.top) / before.height
          zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, label)
          const after = img.getBoundingClientRect()
          box.scrollLeft += after.left + rx * after.width - event.clientX
          box.scrollTop += after.top + ry * after.height - event.clientY
        }, { passive: false })
        img.addEventListener('dblclick', () => {
          view.fit = !view.fit
          view.scale = 1
          applyZoom(label)
          centerScroll()
        })
        box.addEventListener('mousedown', (event) => {
          if (event.button !== 0 || view.fit) return
          dragPan = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop }
          box.dataset.panning = 'true'
          event.preventDefault()
        })

        // 左下角角标：画师 + Pixiv ID，都能点一下复制（文字本身也能选中）
        const badge = document.createElement('div')
        badge.className = 'gxg-badge'
        const artistEl = document.createElement('span')
        artistEl.className = 'gxg-badge-item'
        const idEl = document.createElement('span')
        idEl.className = 'gxg-badge-item gxg-badge-id'
        const artistName = String(item.artist || '').trim()
        const idText = item.id ? `#${item.id}` : (String(item.key || '').startsWith('#') ? String(item.key) : '')
        artistEl.textContent = artistName || '未知画师'
        idEl.textContent = idText || '无 ID'
        for (const [el, text, label] of [[artistEl, artistName, '画师'], [idEl, idText.replace(/^#/, ''), 'ID']]) {
          if (!text) { el.dataset.disabled = 'true'; continue }
          el.title = `点击复制${label}：${text}`
          el.addEventListener('mousedown', (ev) => ev.stopPropagation())
          el.addEventListener('click', async (ev) => {
            ev.stopPropagation()
            const ok = await copyText(text)
            toast(ok ? `已复制${label}：${text}` : `复制失败，请手选文字`)
          })
        }
        badge.append(artistEl, idEl)
        badge.addEventListener('mousedown', (ev) => ev.stopPropagation())

        function positionBadge() {
          if (!img || !badge) return
          const wr = imgWrap.getBoundingClientRect()
          const ir = img.getBoundingClientRect()
          if (ir.width < 40 || ir.height < 40) { badge.style.visibility = 'hidden'; return }
          badge.style.visibility = 'visible'
          const left = Math.max(6, ir.left - wr.left)
          const top = Math.max(6, ir.top - wr.top)
          badge.style.left = `${left + 10}px`
          badge.style.top = `${top + 10}px`
          badge.style.bottom = 'auto'
        }
        const cap = document.createElement('div')
        cap.className = 'gxg-cap'
        const when = String(item.savedAt || '').replace('T', ' ').slice(0, 16)
        cap.textContent = [item.title, item.artist, `${item.pages} 页`, when].filter(Boolean).join(' · ')

        const navPrev = document.createElement('button')
        navPrev.type = 'button'
        navPrev.className = 'gxg-nav prev'
        navPrev.textContent = '‹'
        navPrev.title = '上一个作品'
        navPrev.disabled = pos <= 0
        navPrev.addEventListener('click', (event) => { event.stopPropagation(); goWork(-1) })

        const navNext = document.createElement('button')
        navNext.type = 'button'
        navNext.className = 'gxg-nav next'
        navNext.textContent = '›'
        navNext.title = '下一个作品'
        navNext.disabled = pos < 0 || pos >= visibleItems.length - 1
        navNext.addEventListener('click', (event) => { event.stopPropagation(); goWork(1) })

        function goWork(delta) {
          if (pos < 0) return
          const target = visibleItems[pos + delta]
          if (target) openViewer(target)
        }

        const imgWrap = document.createElement('div')
        imgWrap.className = 'gxg-imgwrap'
        imgWrap.append(box, badge)
        window.addEventListener('resize', positionBadge)
        if (pages.length > 1) imgWrap.append(pager)

        wrap.append(bar, imgWrap, cap, navPrev, navNext)
        body.append(wrap)

        function centerScroll() {
          if (!view || view.fit) return
          box.scrollLeft = Math.max(0, Math.round((box.scrollWidth - box.clientWidth) / 2))
          box.scrollTop = Math.max(0, Math.round((box.scrollHeight - box.clientHeight) / 2))
        }
        function zoomBy(factor, el = label, center = false) {
          if (view.fit) {
            const natural = img.naturalWidth || 800
            const shown = img.clientWidth || natural
            view.scale = shown / natural
            view.fit = false
          }
          view.scale = Math.max(0.1, Math.min(8, view.scale * factor))
          applyZoom(el)
          if (center) centerScroll()
        }
        function applyZoom(el) {
          if (!view) return
          box.dataset.fit = view.fit ? 'true' : 'false'
          if (view.fit) {
            img.style.width = ''
            img.style.height = ''
          } else {
            const natural = img.naturalWidth || 800
            img.style.width = `${Math.round(natural * view.scale)}px`
            img.style.height = 'auto'
          }
          el.textContent = view.fit ? '适应' : `${Math.round(view.scale * 100)}%`
        }
      }

      /* ── 拖动改大小 / 拖动图片 ── */
      for (const dir of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
        const handle = document.createElement('div')
        handle.className = `gxg-edge ${dir}`
        panel.append(handle)
        handle.addEventListener('mousedown', (event) => {
          if (event.button !== 0) return
          const rect = panel.getBoundingClientRect()
          Object.assign(panel.style, {
            left: `${rect.left}px`, top: `${rect.top}px`,
            right: 'auto', bottom: 'auto',
            width: `${rect.width}px`, height: `${rect.height}px`,
          })
          dragResize = { dir, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, w: rect.width, h: rect.height }
          event.preventDefault()
          event.stopPropagation()
        })
      }

      window.addEventListener('mousemove', (event) => {
        if (dragResize !== null) {
          const MIN_W = 320
          const MIN_H = 260
          const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
          const dx = event.clientX - dragResize.x
          const dy = event.clientY - dragResize.y
          let { left, top, w, h } = dragResize
          if (dragResize.dir.includes('e')) w = clamp(w + dx, MIN_W, window.innerWidth - left - 8)
          if (dragResize.dir.includes('s')) h = clamp(h + dy, MIN_H, window.innerHeight - top - 8)
          if (dragResize.dir.includes('w')) {
            const next = clamp(w - dx, MIN_W, left + w - 8)
            left += w - next
            w = next
          }
          if (dragResize.dir.includes('n')) {
            const next = clamp(h - dy, MIN_H, top + h - 8)
            top += h - next
            h = next
          }
          Object.assign(panel.style, { left: `${Math.max(0, left)}px`, top: `${Math.max(0, top)}px`, width: `${w}px`, height: `${h}px` })
          return
        }
        if (dragPan !== null && view?.box) {
          view.box.scrollLeft = dragPan.left - (event.clientX - dragPan.x)
          view.box.scrollTop = dragPan.top - (event.clientY - dragPan.y)
        }
      })

      window.addEventListener('mouseup', () => {
        if (dragResize !== null && panel.dataset.open === 'true') {
          const rect = panel.getBoundingClientRect()
          try {
            window.localStorage.setItem(SIZE_KEY, JSON.stringify({ w: Math.round(rect.width), h: Math.round(rect.height) }))
          } catch { /* 忽略 */ }
          Object.assign(panel.style, {
            left: 'auto',
            right: `${Math.max(8, window.innerWidth - rect.right)}px`,
            top: `${Math.max(0, rect.top)}px`,
            bottom: 'auto',
          })
        }
        dragResize = null
        dragPan = null
        if (view?.box) delete view.box.dataset.panning
      })

      document.body.append(launcher, panel)
      syncHead()

      // 打开着就每 20 秒刷一次（别的插件存完图，图库会自动出现）
      pollTimer = window.setInterval(() => {
        if (!panel.isConnected) return
        if (panel.dataset.open === 'true' && view === null) void load(false)
      }, 20000)

      return {
        launcher,
        panel,
        open() { setOpen(true) },
        refresh() { if (panel.dataset.open === 'true') void load(false) },
        dispose() {
          window.clearInterval(pollTimer)
          closeMenu()
          launcher.remove()
          panel.remove()
        },
      }
    }

    /* ── 设置页：图库目录 / 显示名 ── */
    function TextField({ label, note, value, placeholder, onCommit }) {
      const [text, setText] = React.useState(value ?? '')
      const [busy, setBusy] = React.useState(false)
      React.useEffect(() => { setText(value ?? '') }, [value])
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 0' } },
        h('div', { style: { fontSize: 13 } }, label),
        note ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#8a9099)' } }, note) : null,
        h('div', { style: { display: 'flex', gap: 8 } },
          h('input', {
            value: text,
            placeholder: placeholder || '',
            onChange: (e) => setText(e.target.value),
            style: {
              flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2,rgba(128,140,160,.25))',
              background: 'var(--dsw-alias-bg-layer-2,#15171c)', color: 'inherit', font: 'inherit',
            },
          }),
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: async () => {
              setBusy(true)
              try { await onCommit(text.trim()) } finally { setBusy(false) }
            },
            style: { padding: '6px 12px', borderRadius: 6, border: 0, cursor: 'pointer' },
          }, busy ? '保存中…' : '保存'),
        ),
      )
    }

    function SettingsPanel() {
      const [cfg, setCfg] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [note, setNote] = React.useState('')
      const load = React.useCallback(async () => {
        try {
          const r = await jget('/config')
          setCfg(r?.cfg || null)
          setErr('')
        } catch (e) { setErr(String(e?.message ?? e)) }
      }, [])
      React.useEffect(() => { void load() }, [load])
      const save = async (patch) => {
        try {
          const r = await jpost('/config', patch)
          setCfg(r?.cfg || null)
          setNote('已保存')
          setTimeout(() => setNote(''), 2000)
        } catch (e) { setErr(String(e?.message ?? e)) }
      }
      if (err) return h('div', { style: { color: '#ff6b6b', fontSize: 12 } }, `读取配置失败：${err}`)
      if (!cfg) return h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#8a9099)' } }, '读取中…')
      return h('div', { style: { maxWidth: 560 } },
        h('div', { style: { fontSize: 14, marginBottom: 6 } }, '图库'),
        h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#8a9099)' } },
          '右上角那个图标就是图库面板。目录里如果有 _meta/*.json（抓取插件存的），按作品显示；没有就把图片文件当作品。'),
        h(TextField, {
          label: '显示名', note: '面板标题，随便叫', value: cfg.title, placeholder: '我的图库',
          onCommit: (v) => save({ title: v || '我的图库' }),
        }),
        h(TextField, {
          label: '图库目录', note: '绝对路径；留空 = 插件家目录下的 library/', value: cfg.root, placeholder: 'D:\\Pictures\\我的图库',
          onCommit: (v) => save({ root: v }),
        }),
        h(TextField, {
          label: '缩略图目录名', note: '作品元数据目录（默认 _meta）；改错了作品会认不出来', value: cfg.metaDir, placeholder: '_meta',
          onCommit: (v) => save({ metaDir: v || '_meta' }),
        }),
        note ? h('div', { style: { fontSize: 12, color: '#7bd88f' } }, note) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let gallery = null
        try {
          gallery = installGallery()
          ctx.effect(() => () => gallery?.dispose(), 'gallery: 面板')
        } catch (failure) {
          console.warn('[dsh-gallery] 面板挂载失败', failure)
        }

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots?.inject || !slots?.register) return
        ctx.effect(() => slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'gallery', order: 40, label: '图库' },
          () => h(SettingsPanel),
        )), 'gallery: 设置页')
      },
    }
  },
})
