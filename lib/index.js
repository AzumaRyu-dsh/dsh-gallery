/**
 * dsh-gallery —— 宿主半端
 * ============================================================================
 * 只做三件事：
 *   · 提供一个只读/可写「图库根目录」的 HTTP 接口（列表、喜好、垃圾桶、还原）
 *   · 把配置放在 `$DSH_HOME/gallery/config.json`
 *   · 不依赖任何抓取插件：有 `_meta/*.json` 就按作品列，没有就把图片文件当作品
 * ============================================================================
 */
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadCfg, saveCfg, configFile } from './config.mjs'
import { registerHttp } from './http.mjs'

export const name = 'gallery'
export const inject = ['webServer']

/** 插件家目录：$DSH_HOME/gallery */
function homeOf(ctx) {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv) return join(fromEnv, 'gallery')
  return join(homedir(), '.dsh', 'gallery')
}

export function apply(ctx, config = {}) {
  const home = homeOf(ctx)
  const log = (m) => {
    try { ctx.logger?.('gallery')?.info?.(m) } catch { /* 忽略 */ }
  }

  try { mkdirSync(home, { recursive: true }) } catch { /* 忽略 */ }

  // 首次运行：把 cordis 层的原始配置种进 config.json（之后以本地为准）
  if (!existsSync(configFile(home))) {
    const seed = {}
    if (typeof config?.title === 'string' && config.title) seed.title = config.title
    if (typeof config?.root === 'string' && config.root) seed.root = config.root
    saveCfg(home, seed)
    log('已初始化 config.json')
  }

  try {
    const api = registerHttp(ctx, { home, log })
    ctx.effect(() => () => api.dispose?.(), 'gallery: http')
    log(`已激活（home=${home}, 图库=${loadCfg(home).root || '(默认 <home>/library)'}）`)
  } catch (e) {
    log(`HTTP 挂载失败：${e?.message ?? e}`)
  }
}
