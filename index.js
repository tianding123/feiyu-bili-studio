/**
 * feiyu-bili-studio —— host 半边
 *
 * 「B站创作台」：独立扫码登录（凭证跟刷B站分开）、生成视频、投稿。
 *
 * 约定：
 *   · 全程 try/catch，绝不向上抛 —— 这个插件挂了不该影响 DSH 启动
 *   · 不 append session 事件、不碰别人的服务
 *   · 数据全在 $DSH_HOME/bili-studio/，不碰 bili-duty 那份
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loginStart, loginPoll, saveCredential, renderQrPng } from './lib/login.mjs'

export const name = 'feiyu-bili-studio'
export const inject = ['webServer']

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const VENDOR_DIR = join(PKG_DIR, 'vendor')

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STUDIO_DIR = join(DSH_HOME, 'bili-studio')
const CRED_FILE = join(STUDIO_DIR, 'bili_credential.json')
const CFG_FILE = join(STUDIO_DIR, 'config.json')
const OUT_DIR = join(STUDIO_DIR, 'out')

/** 复用刷B站的 Python 环境（edge_tts / bilibili_api 都在里面） */
const VENV_PY = join(DSH_HOME, 'bili-duty', '.venv', 'Scripts', 'python.exe')

// ── bili-cli 适配层（2026-10-22 加）────────────────────────────────────────
// 不重写 bili-cli 的 20+ 功能：设置页点按钮 → 这里跑 `bili.exe` → 把 JSON 返回。
// 位置：~/.dsh/bili-cli/.venv/Scripts/bili.exe
// 数据：%APPDATA%\bili-cli\credential.json（跟本插件那份完全隔离）
function biliExePath() {
  const cands = [
    join(DSH_HOME, 'bili-cli', '.venv', 'Scripts', 'bili.exe'),
    join(DSH_HOME, 'bili-cli', '.venv', 'Scripts', 'bili'),
    join(DSH_HOME, 'bili-cli', '.venv', 'bin', 'bili'),
  ]
  for (const p of cands) {
    try {
      if (existsSync(p)) return p
    } catch { /* ignore */ }
  }
  return ''
}

/** 跑 bili 命令，解析它 stdout 的那一个 JSON */
function runBiliCli(args, timeout = 120000) {
  return new Promise((resolve) => {
    const exe = biliExePath()
    if (!exe) {
      resolve({ ok: false, error: '没找到 bili-cli（先装 bili-agent）' })
      return
    }
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
    } catch (e) {
      resolve({ ok: false, error: String(e?.message ?? e) })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
    }, timeout)
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: String(e?.message ?? e) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const text = out.trim()
      if (text) {
        try {
          resolve(JSON.parse(text))
          return
        } catch { /* 试单行 */ }
        try {
          resolve(JSON.parse(text.split('\n')[0].trim()))
          return
        } catch { /* 不是 JSON */ }
      }
      resolve({
        ok: false,
        error: (err.trim() || text || `bili 退出码 ${code}`).slice(-1200),
      })
    })
  })
}

const DEFAULTS = {
  // 视频生成
  voice: 'zh-CN-XiaoxiaoNeural', // edge-tts 音色
  width: 1280,
  height: 720,
  fps: 30,
  // 投稿
  tid: 124,
  tags: 'AI',
  noReprint: true,
  // 上次用的标题/简介（方便复用）
  lastTitle: '',
  lastDesc: '',
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

function cfg() {
  return { ...DEFAULTS, ...readJson(CFG_FILE, {}) }
}

function credential() {
  const c = readJson(CRED_FILE, null)
  if (!c || !c.sessdata) return null
  return c
}

function pyPath() {
  return existsSync(VENV_PY) ? VENV_PY : ''
}

/** 跑 python，收 stdout/stderr */
function runPy(args, timeout = 600000) {
  return new Promise((resolve) => {
    const py = pyPath()
    if (!py) {
      resolve({ code: -1, out: '', err: `找不到 Python 环境：${VENV_PY}（先装「刷B站」插件，会一起建好）` })
      return
    }
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(py, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    } catch (e) {
      resolve({ code: -1, out, err: String(e?.message ?? e) })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
    }, timeout)
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e?.message ?? e) }) })
    child.on('exit', (c) => { clearTimeout(timer); resolve({ code: c ?? -1, out, err }) })
  })
}

function send(res, code, obj) {
  try {
    const body = JSON.stringify(obj)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch { /* 客户端断了就算了 */ }
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/** 用 nav 接口确认登录态（只认 isLogin，别用别的接口冒充） */
async function whoami(sess) {
  try {
    const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Cookie: `SESSDATA=${sess.sessdata}`,
      },
    })
    const j = await r.json()
    const d = j?.data || {}
    return {
      loggedIn: d.isLogin === true,
      name: d.uname || '',
      uid: d.mid || 0,
      vip: d.vipStatus === 1,
    }
  } catch (e) {
    return { loggedIn: false, error: String(e?.message || e) }
  }
}

async function handle(req, res, url) {
  const path = url.pathname.replace(/^\/api\/feiyu-studio/, '') || '/'

  // ── 状态 ──
  if (req.method === 'GET' && path === '/status') {
    const c = credential()
    const who = c ? await whoami(c) : { loggedIn: false }
    return send(res, 200, {
      ok: true,
      config: cfg(),
      loggedIn: who.loggedIn === true,
      account: who.loggedIn ? { name: who.name, uid: who.uid, vip: who.vip } : null,
      python: pyPath() || null,
      studioDir: STUDIO_DIR,
      outDir: OUT_DIR,
    })
  }

  // ── bili-cli：状态 ──
  if (req.method === 'GET' && path === '/bili/status') {
    const exe = biliExePath()
    if (!exe) {
      return send(res, 200, {
        ok: false,
        installed: false,
        hint: '没找到 bili-cli：先 pip install bili-agent',
      })
    }
    let auth = null
    try {
      auth = await runBiliCli(['auth', 'status'], 30000)
    } catch { /* ignore */ }
    return send(res, 200, { ok: true, installed: true, exe, auth })
  }

  // ── bili-cli：通用转发（白名单 + 防注入）──
  if (req.method === 'POST' && path === '/bili/run') {
    const body = await readBody(req)
    const args = Array.isArray(body.args) ? body.args.map((x) => String(x)) : []
    if (!args.length) return send(res, 200, { ok: false, error: '缺 args' })

    const ALLOW = new Set([
      'me', 'hot', 'feed', 'video', 'comment', 'danmaku',
      'dynamic', 'upload', 'user', 'search', 'dm', 'owner', 'asr',
    ])
    if (!ALLOW.has(args[0])) {
      return send(res, 200, { ok: false, error: `命令「${args[0]}」不在白名单里` })
    }
    for (const a of args) {
      if (/[;&|`$><]/.test(a)) {
        return send(res, 200, { ok: false, error: '参数里有非法字符' })
      }
    }

    const r = await runBiliCli(args, 180000)
    return send(res, 200, r)
  }

  // ── 扫码登录：开始 ──
  if (req.method === 'POST' && path === '/login/start') {
    try {
      const { key, url: qrUrl } = await loginStart()
      mkdirSync(STUDIO_DIR, { recursive: true })
      // ⚠️ renderQrPng 返回的是【文件路径】，必须读成 base64 拼 data URL，
      //    否则前端 <img src="C:\...png"> 加载不了（2026-10-22 踩过，图裂）
      let qr = null
      try {
        const png = await renderQrPng(pyPath(), STUDIO_DIR, qrUrl)
        if (png && existsSync(png)) {
          qr = 'data:image/png;base64,' + readFileSync(png).toString('base64')
        }
      } catch { /* 画不出就只给链接 */ }
      return send(res, 200, { ok: true, key, qr, qrUrl })
    } catch (e) {
      return send(res, 200, { ok: false, error: String(e?.message || e) })
    }
  }

  // ── 扫码登录：轮询 ──
  if (req.method === 'POST' && path === '/login/poll') {
    const body = await readBody(req)
    const key = String(body.key || '')
    if (!key) return send(res, 200, { ok: false, error: '缺 key' })
    try {
      const r = await loginPoll(key)
      if (r.state === 'ok') {
        // ⭐ 关键：凭证写进 bili-studio 自己的目录，不碰 bili-duty
        const file = saveCredential(STUDIO_DIR, r.credential)
        const who = await whoami(r.credential)
        return send(res, 200, {
          ok: true,
          state: 'ok',
          file,
          account: { name: who.name, uid: who.uid, loggedIn: who.loggedIn === true },
        })
      }
      return send(res, 200, { ok: true, state: r.state, message: r.message || '' })
    } catch (e) {
      return send(res, 200, { ok: false, error: String(e?.message || e) })
    }
  }

  // ── 退出登录 ──
  if (req.method === 'POST' && path === '/logout') {
    try {
      if (existsSync(CRED_FILE)) writeFileSync(CRED_FILE, '{}', 'utf8')
      return send(res, 200, { ok: true })
    } catch (e) {
      return send(res, 200, { ok: false, error: String(e?.message || e) })
    }
  }

  // ── 保存设置 ──
  if (req.method === 'POST' && path === '/config') {
    const patch = await readBody(req)
    if (!patch || typeof patch !== 'object') return send(res, 400, { ok: false, error: 'body 必须是对象' })
    const ALLOWED = new Set(['voice', 'width', 'height', 'fps', 'tid', 'tags', 'noReprint', 'lastTitle', 'lastDesc'])
    const next = { ...cfg() }
    for (const [k, v] of Object.entries(patch)) {
      if (ALLOWED.has(k)) next[k] = v
    }
    if (!writeJson(CFG_FILE, next)) return send(res, 500, { ok: false, error: `写不进去：${CFG_FILE}` })
    return send(res, 200, { ok: true, config: next })
  }

  // ── 生成视频 ──
  if (req.method === 'POST' && path === '/generate') {
    const body = await readBody(req)
    const title = String(body.title || '').trim()
    const script = String(body.script || '').trim()
    if (!script) return send(res, 200, { ok: false, error: '脚本是空的' })
    if (!pyPath()) return send(res, 200, { ok: false, error: '找不到 Python 环境（先装「刷B站」插件）' })

    mkdirSync(OUT_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const outFile = join(OUT_DIR, `${stamp}.mp4`)

    const args = [
      join(VENDOR_DIR, 'bili_studio.py'),
      'generate',
      '--script', script,
      '--out', outFile,
      '--voice', String(body.voice || cfg().voice),
      '--width', String(body.width || cfg().width),
      '--height', String(body.height || cfg().height),
    ]

    const r = await runPy(args)
    let parsed = null
    try {
      parsed = JSON.parse(r.out.trim().split('\n').pop() || '{}')
    } catch { /* 保持 null */ }

    if (r.code !== 0 || !parsed || parsed.ok !== true) {
      return send(res, 200, {
        ok: false,
        error: parsed?.error || r.err.slice(-800) || `python 退出码 ${r.code}`,
      })
    }
    return send(res, 200, { ok: true, file: outFile, ...parsed })
  }

  // ── 投稿 ──
  if (req.method === 'POST' && path === '/upload') {
    const c = credential()
    if (!c) return send(res, 200, { ok: false, error: '还没扫码登录' })

    const body = await readBody(req)
    const videoPath = String(body.videoPath || '').trim()
    const title = String(body.title || '').trim()
    if (!videoPath || !existsSync(videoPath)) return send(res, 200, { ok: false, error: `视频文件不存在：${videoPath}` })
    if (!title) return send(res, 200, { ok: false, error: '标题是空的' })

    const k = cfg()
    const args = [
      join(VENDOR_DIR, 'bili_studio.py'),
      'upload',
      '--video', videoPath,
      '--title', title,
      '--desc', String(body.desc || ''),
      '--tid', String(body.tid ?? k.tid),
      '--tags', String(body.tags || k.tags),
      '--cred', CRED_FILE,
    ]
    if (body.coverPath) args.push('--cover', String(body.coverPath))

    const r = await runPy(args)
    let parsed = null
    try {
      parsed = JSON.parse(r.out.trim().split('\n').pop() || '{}')
    } catch { /* 保持 null */ }

    if (r.code !== 0 || !parsed || parsed.ok !== true) {
      return send(res, 200, { ok: false, error: parsed?.error || r.err.slice(-800) || `python 退出码 ${r.code}` })
    }
    return send(res, 200, { ok: true, ...parsed })
  }

  return send(res, 404, { ok: false, error: `没有这个接口：${path}` })
}

export function apply(ctx) {
  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/feiyu-studio',
      handler: async (req, res) => {
        try {
          await handle(req, res, new URL(req.url, 'http://127.0.0.1'))
        } catch (e) {
          send(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'feiyu-bili-studio: /api/feiyu-studio 路由')
  } catch { /* 没 webServer 就算了，别影响启动 */ }

  // 数据目录先建好
  try {
    mkdirSync(STUDIO_DIR, { recursive: true })
    mkdirSync(OUT_DIR, { recursive: true })
  } catch { /* ignore */ }
}
