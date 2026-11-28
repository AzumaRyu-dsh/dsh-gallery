/**
 * lib/index-cache.mjs —— 图库索引缓存
 * ============================================================================
 * 为什么要它：图库每次打开都要把整棵树扫一遍（读每个 _meta/*.json）。
 * 库有 2000+ 文件、还在机械盘上，遇到缩略图预热或收图进程同时跑，就会把
 * 普通列表请求挤到超时。
 *
 * 做法：
 *   - 内存里留一份快照；TTL 内直接返回
 *   - 快照同时落盘（插件家目录 index-cache.json），重启后第一次打开它很快
 *   - 图库自己的写操作（删/还原/彻底删/喜好）会主动 invalidate
 *   - 外部变化（收图进程往库里写）用 fs.watch 监听，**防抖 3 秒 + 最快 30 秒重建一次**
 *     —— 收图时会不停写文件，不能一写就重扫
 * ============================================================================
 */
import { watch } from 'node:fs'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const MEM_TTL_MS = 120 * 1000 // 内存快照 2 分钟内直接用
const DISK_TTL_MS = 6 * 3600 * 1000 // 落盘快照 6 小时内可用（冷启动时先顶上）
const REBUILD_MIN_GAP = 30 * 1000 // 两次重建之间至少隔 30 秒
const DEBOUNCE_MS = 3000

export function createGalleryCache({ root, home, log = () => {}, listFn }) {
  const diskFile = join(home, 'index-cache.json')
  let mem = null // { items, total, builtAt }
  let dirty = false
  let lastBuild = 0
  let timer = null
  let watcher = null

  function loadDisk() {
    try {
      const j = JSON.parse(readFileSync(diskFile, 'utf8'))
      if (j && j.root === root && Array.isArray(j.items) && j.builtAt) return j
    } catch { /* 没有或坏了 */ }
    return null
  }

  function saveDisk(snap) {
    try {
      const tmp = diskFile + '.tmp'
      writeFileSync(tmp, JSON.stringify({ root, builtAt: snap.builtAt, total: snap.total, items: snap.items }), 'utf8')
      renameSync(tmp, diskFile)
    } catch (e) { log(`索引缓存写盘失败：${e?.message ?? e}`) }
  }

  function build() {
    const t0 = Date.now()
    const listed = listFn()
    mem = { items: listed.items, total: listed.total ?? listed.items.length, builtAt: Date.now() }
    dirty = false
    lastBuild = Date.now()
    saveDisk(mem)
    log(`索引已重建：${mem.items.length}/${mem.total} 件，用时 ${Date.now() - t0}ms`)
    return mem
  }

  /** 拿快照：优先内存 → 磁盘 → 现扫 */
  function snapshot({ allowStale = false } = {}) {
    const now = Date.now()
    if (mem && !dirty && now - mem.builtAt < MEM_TTL_MS) return mem
    // 脏了但快照还新鲜：先把旧的给出去，后台重建（收图时会连续写文件，不能每个请求都同步重扫）
    if (mem && now - mem.builtAt < 60 * 1000) {
      if (dirty) scheduleRebuild()
      return mem
    }
    if (!mem) {
      const d = loadDisk()
      if (d && (allowStale || now - d.builtAt < DISK_TTL_MS)) {
        mem = { items: d.items, total: d.total, builtAt: d.builtAt }
        if (!dirty) {
          // 先用磁盘快照顶上，同时后台重建一次拿最新的
          scheduleRebuild(true)
          return mem
        }
      }
    }
    return build()
  }

  function scheduleRebuild(force = false) {
    if (timer) return
    const wait = force ? 0 : Math.max(DEBOUNCE_MS, REBUILD_MIN_GAP - (Date.now() - lastBuild))
    timer = setTimeout(() => {
      timer = null
      if (!dirty && !force) return
      try { build() } catch (e) { log(`索引重建失败：${e?.message ?? e}`) }
    }, wait)
    if (timer.unref) timer.unref()
  }

  function invalidate(reason = '') {
    dirty = true
    if (reason) log(`索引失效（${reason}），稍后重建`)
    scheduleRebuild()
  }

  function startWatch() {
    if (watcher || !root) return
    try {
      watcher = watch(root, { recursive: true }, (_evt, file) => {
        const n = String(file || '')
        if (!n) return
        // 忽略缩略图/垃圾桶/缓存自身，避免自己触发自己
        if (n.includes('_thumbs') || n.includes('_trash')) return
        invalidate()
      })
      log('索引监听已启动（递归监听图库目录）')
    } catch (e) {
      log(`索引监听启动失败（不致命）：${e?.message ?? e}`)
    }
  }

  function stop() {
    if (watcher) { try { watcher.close() } catch { /* 忽略 */ } watcher = null }
    if (timer) { clearTimeout(timer); timer = null }
  }

  return { snapshot, invalidate, startWatch, stop, _state: () => ({ mem, dirty, lastBuild }) }
}
