/**
 * lib/thumbs.mjs —— 缩略图（看图墙别拉原图）
 * ============================================================================
 * 原图平均 2.8 MB、最大 24 MB，一屏 6 张就是十几 MB —— 图库慢的根因。
 * 这里按需生成 480px 的 jpg 缓存到 `<图库>/_thumbs/<sha1>.jpg`，
 * 用 Windows 自带的 System.Drawing，不引入任何原生依赖。
 *
 * 生成是**串行**的（同一时刻只跑一个 PowerShell），避免一屏 20 张同时开进程把机器拖住。
 * ============================================================================
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'

const THUMB_DIR = '_thumbs'

/** 缩略图相对原图的键 */
export function thumbName(rel) {
  return `${createHash('sha1').update(String(rel)).digest('hex').slice(0, 16)}.jpg`
}

export function thumbAbs(root, rel) {
  return join(root, THUMB_DIR, thumbName(rel))
}

/** 串行队列：所有生成任务排队跑 */
let queue = Promise.resolve()

function runPs(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 20000 }, (err, _out, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).slice(0, 200)))
        else resolve()
      })
  })
}

/**
 * 确保缩略图存在（不存在就生成）。
 * @returns {Promise<string|null>} 缩略图绝对路径；失败返回 null
 */
export function ensureThumb(root, rel, srcAbs, { maxEdge = 480 } = {}) {
  const out = thumbAbs(root, rel)
  try {
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(srcAbs).mtimeMs) return Promise.resolve(out)
  } catch { /* 继续生成 */ }

  const task = queue.then(async () => {
    try {
      if (existsSync(out) && statSync(out).mtimeMs >= statSync(srcAbs).mtimeMs) return out
      mkdirSync(join(root, THUMB_DIR), { recursive: true })
      const ps = [
        'Add-Type -AssemblyName System.Drawing',
        `$src='${String(srcAbs).replace(/'/g, "''")}'`,
        `$dst='${String(out).replace(/'/g, "''")}'`,
        '$img=[System.Drawing.Image]::FromFile($src)',
        'try {',
        `  $r=${maxEdge} / [Math]::Max($img.Width,$img.Height)`,
        '  if ($r -gt 1) { $r = 1 }',
        '  $w=[Math]::Max(1,[int]($img.Width*$r)); $h=[Math]::Max(1,[int]($img.Height*$r))',
        '  $bmp=New-Object System.Drawing.Bitmap($w,$h)',
        '  $g=[System.Drawing.Graphics]::FromImage($bmp)',
        '  $g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
        '  $g.DrawImage($img,0,0,$w,$h)',
        '  $enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }',
        '  $p=New-Object System.Drawing.Imaging.EncoderParameters(1)',
        '  $p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]80)',
        '  $bmp.Save($dst,$enc,$p)',
        '  $g.Dispose(); $bmp.Dispose()',
        '} finally { $img.Dispose() }',
      ].join('\n')
      await runPs(ps)
      return existsSync(out) ? out : null
    } catch {
      return null
    }
  })
  queue = task.catch(() => {})
  return task
}
