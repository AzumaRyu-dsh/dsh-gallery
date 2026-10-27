/**
 * lib/stats.mjs —— 图库统计
 * ============================================================================
 * 两块钱数据：
 *   ① 图库自己的：总数、今天新增、R18、多页、喜好、垃圾桶
 *   ② 抓取插件那边的（**有就用，没有就跳过**）：
 *      `$DSH_HOME/pixiv-duty/ledger.jsonl`（存了什么）、`usage.jsonl`（每轮 token/花费）、
 *      `out/<日期>.md`（跳过了什么、为什么）
 * 这样图库单独也能用，装了抓取插件就多一块「今天跑了多少轮、花了多少」。
 * ============================================================================
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 24 * 3600 * 1000

/** 本地日期键 */
export function localDay(at) {
  const d = at ? new Date(at) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function readJsonl(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

/** 报表里的「未存」条目：`- 未存：原因` */
function readSkipped(reportFile) {
  let text = ''
  try { text = readFileSync(reportFile, 'utf8') } catch { return null }
  const lines = text.split(/\r?\n/)
  const reasons = []
  let total = 0
  for (const line of lines) {
    const m = /^-\s*未存[：:]\s*(.+)$/.exec(line.trim())
    if (!m) continue
    total++
    reasons.push(String(m[1]).trim().slice(0, 40))
  }
  return { total, reasons }
}

function topN(list, n = 5) {
  const map = new Map()
  for (const item of list) {
    const k = String(item || '').trim()
    if (!k) continue
    map.set(k, (map.get(k) || 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, v }))
}

/**
 * @param {object} opts
 * @param {Array} opts.items 图库条目（listGallery 的结果）
 * @param {number} opts.trashCount
 * @param {string} opts.pixivHome 抓取插件家目录（不存在就只出图库那半块）
 */
export function buildStats({ items = [], trashCount = 0, pixivHome = '' } = {}) {
  const today = localDay()
  const yesterday = localDay(Date.now() - DAY_MS)

  const gallery = {
    total: items.length,
    todayAdded: items.filter((it) => localDay(it.savedAt) === today).length,
    yesterdayAdded: items.filter((it) => localDay(it.savedAt) === yesterday).length,
    favs: items.filter((it) => it.fav === true).length,
    r18: items.filter((it) => it.rating && it.rating !== 'all').length,
    multiPage: items.filter((it) => Number(it.pages) > 1).length,
    pages: items.reduce((n, it) => n + (Number(it.pages) || 0), 0),
    trash: trashCount,
  }

  const byDay = new Map()
  for (const it of items) {
    const d = localDay(it.savedAt)
    if (!d) continue
    byDay.set(d, (byDay.get(d) || 0) + 1)
  }
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7)
    .map(([day, count]) => ({ day, count }))

  if (!pixivHome || !existsSync(pixivHome)) return { day: today, gallery, days, pixiv: null }

  const ledger = readJsonl(join(pixivHome, 'ledger.jsonl'))
  const usage = readJsonl(join(pixivHome, 'usage.jsonl'))

  const savedToday = ledger.filter((r) => r.action === 'saved' && localDay(r.at) === today)
  const skipped = readSkipped(join(pixivHome, 'out', `${today}.md`))
  const usageToday = usage.filter((r) => localDay(r.at || r.startedAt) === today)

  const roundIds = new Set([
    ...savedToday.map((r) => r.round).filter(Boolean),
    ...usageToday.map((r) => r.roundId).filter(Boolean),
  ])
  const rounds = [...roundIds].map((id) => {
    const u = usage.find((x) => x.roundId === id) || null
    const rows = savedToday.filter((r) => r.round === id)
    return {
      id,
      at: u?.startedAt || u?.at || (rows[0]?.at ?? ''),
      saved: rows.length,
      tokens: u?.total ?? null,
      costCNY: u?.costCNY ?? null,
      // code 在 state.last 里，只有最后一轮有；这里用「是否有用量记录」粗判
      ok: Boolean(u),
    }
  }).sort((a, b) => String(a.at).localeCompare(String(b.at)))

  return {
    day: today,
    gallery,
    days,
    pixiv: {
      rounds,
      roundCount: rounds.length,
      saved: savedToday.length,
      skipped: skipped ? skipped.total : null,
      keywords: topN(savedToday.map((r) => r.keyword), 5),
      reasons: skipped ? topN(skipped.reasons, 5) : [],
      ratings: {
        r18: savedToday.filter((r) => r.rating && r.rating !== 'all').length,
        all: savedToday.filter((r) => !r.rating || r.rating === 'all').length,
      },
      tokens: usageToday.reduce((n, r) => n + (Number(r.total) || 0), 0),
      costCNY: Math.round(usageToday.reduce((n, r) => n + (Number(r.costCNY) || 0), 0) * 10000) / 10000,
      lastRound: usageToday.slice(-1)[0] || null,
    },
  }
}
