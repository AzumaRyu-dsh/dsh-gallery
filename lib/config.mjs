/**
 * lib/config.mjs —— 图库配置
 * ============================================================================
 * 配置与运行数据都在 `$DSH_HOME/gallery/`，不写进插件包目录。
 *   config.json   用户设置（图库目录、显示名、meta/垃圾桶目录名）
 *   state.json    程序自己的状态（纯图片模式下的「喜好」标记）
 * ============================================================================
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULTS = Object.freeze({
  enabled: true,
  /** 面板标题，也是设置页的名字——用户想叫什么都行 */
  title: '我的图库',
  /** 图库根目录；空 = <home>/library */
  root: '',
  /** 作品元数据目录名（每件一个 json） */
  metaDir: '_meta',
  /** 垃圾桶目录名（放在图库根目录里，跟着图库一起搬） */
  trashDir: '_trash',
  /** 一次最多列多少件 */
  pageLimit: 120,
})

const LIMITS = { pageLimit: [10, 500] }

export function configFile(home) { return join(home, 'config.json') }
export function stateFile(home) { return join(home, 'state.json') }

/** 补默认值 + 钳制 */
export function clampCfg(raw) {
  const out = { ...DEFAULTS }
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = raw?.[k]
    if (v === undefined || v === null) continue
    if (typeof def === 'boolean') { out[k] = Boolean(v); continue }
    if (typeof def === 'number') {
      const n = Number(v)
      const [min, max] = LIMITS[k] || [0, Number.MAX_SAFE_INTEGER]
      out[k] = Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def
      continue
    }
    out[k] = String(v)
  }
  out.title = String(out.title || DEFAULTS.title).trim().slice(0, 40) || DEFAULTS.title
  out.root = String(out.root || '').trim()
  out.metaDir = String(out.metaDir || DEFAULTS.metaDir).trim() || DEFAULTS.metaDir
  out.trashDir = String(out.trashDir || DEFAULTS.trashDir).trim() || DEFAULTS.trashDir
  // 这两个是目录名，不能带路径分隔符，免得把东西扔到图库外面去
  for (const k of ['metaDir', 'trashDir']) {
    if (/[\\/]|^\.\.$/.test(out[k])) out[k] = DEFAULTS[k]
  }
  return out
}

export function loadCfg(home) {
  let raw = {}
  try { raw = JSON.parse(readFileSync(configFile(home), 'utf8')) } catch { /* 第一次跑 */ }
  return clampCfg(raw)
}

export function saveCfg(home, patch) {
  const next = clampCfg({ ...loadCfg(home), ...(patch || {}) })
  try { mkdirSync(home, { recursive: true }) } catch { /* 忽略 */ }
  const f = configFile(home)
  const tmp = `${f}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, f)
  return next
}

/** 图库根目录（空 = <home>/library） */
export function resolveRoot(cfg, home) {
  return cfg.root ? cfg.root : join(home, 'library')
}

/** 纯图片模式下的状态（喜好标记） */
export function readState(home) {
  try {
    const st = JSON.parse(readFileSync(stateFile(home), 'utf8'))
    return st && typeof st === 'object' ? st : {}
  } catch { return {} }
}

export function writeState(home, st) {
  try {
    mkdirSync(home, { recursive: true })
    const f = stateFile(home)
    const tmp = `${f}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8')
    renameSync(tmp, f)
    return true
  } catch { return false }
}

export function rootExists(cfg, home) {
  return existsSync(resolveRoot(cfg, home))
}
