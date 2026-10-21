/**
 * feiyu-bili-studio —— 浏览器半边（设置页里的一页「B站创作台」）
 *
 * client bundle 是**自注册脚本**，不是 ESM：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 * 数据面：host 那半边开的 `/api/feiyu-studio/*`。
 * 凭证独立存在 `$DSH_HOME/bili-studio/bili_credential.json`，跟「刷B站」那个号互不影响。
 */
window.__ModuleLoader__.load({
  id: 'feiyu-bili-studio',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/feiyu-studio'
    const jget = async (p) => (await fetch(API + p, { credentials: 'same-origin' })).json()
    const jpost = async (p, body) => (await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })).json()

    const CSS = `
[data-fst]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:660px;}
[data-fst-sec]{display:flex;flex-direction:column;gap:10px;}
[data-fst-h]{font-size:15px;font-weight:700;letter-spacing:.01em;
  color:var(--dsw-alias-label-primary,#e8eaed);margin-bottom:2px;}
[data-fst-row]{display:flex;align-items:center;gap:10px;}
[data-fst-grow]{flex:1;min-width:0;}
[data-fst-label]{font-size:12px;font-weight:500;}
[data-fst-note]{font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-fst-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  background:var(--dsw-alias-bg-l2,rgba(128,128,128,.10));color:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));outline:none;font-family:inherit;
  color-scheme:dark;}
[data-fst-input]:focus{border-color:#3b82f6;}
[data-fst-area]{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;font-size:12px;
  min-height:110px;resize:vertical;line-height:1.6;
  background:var(--dsw-alias-bg-l2,rgba(128,128,128,.10));color:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));outline:none;font-family:inherit;
  color-scheme:dark;}
[data-fst-area]:focus{border-color:#3b82f6;}
[data-fst-btn]{flex:none;padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));
  background:var(--dsw-alias-bg-l2,rgba(128,128,128,.10));color:inherit;font-family:inherit;}
[data-fst-btn]:hover{background:rgba(128,128,128,.18);}
[data-fst-btn][data-primary]{border-color:rgba(59,130,246,.7);background:rgba(59,130,246,.16);color:#7ea6e0;}
[data-fst-btn]:disabled{opacity:.45;cursor:not-allowed;}
[data-fst-btn][data-danger]{border-color:rgba(239,68,68,.5);color:#ef9a9a;}
[data-fst-ok]{font-size:11px;color:#7fd47f;line-height:1.6;word-break:break-all;}
[data-fst-err]{font-size:11px;color:#ff8a80;line-height:1.6;word-break:break-all;}
[data-fst-log]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.5;
  background:rgba(0,0,0,.22);border-radius:6px;padding:6px 8px;max-height:120px;overflow:auto;
  white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary,#9aa0a6);}
[data-fst-qr]{display:flex;gap:14px;align-items:flex-start;}
[data-fst-qr img]{width:150px;height:150px;border-radius:8px;background:#fff;padding:6px;box-sizing:content-box;}
[data-fst-acct]{font-size:12px;line-height:1.7;}
`

    // ── 小组件 ──
    function Section({ title, children }) {
      return h('div', { 'data-fst-sec': '' },
        h('div', { 'data-fst-h': '' }, title),
        children,
      )
    }

    function Field({ label, note, children }) {
      return h('div', {},
        h('div', { 'data-fst-label': '' }, label),
        note ? h('div', { 'data-fst-note': '', style: { marginBottom: '4px' } }, note) : null,
        children,
      )
    }

    function Panel() {
      const [loading, setLoading] = React.useState(true)
      const [st, setSt] = React.useState({})
      const [cfg, setCfg] = React.useState({})
      const [msg, setMsg] = React.useState(null)

      // ── bili-cli 适配（2026-10-22）──
      const [biliState, setBiliState] = React.useState(null)
      const [biliBusy, setBiliBusy] = React.useState('')
      const [statsData, setStatsData] = React.useState(null)
      const [hotData, setHotData] = React.useState(null)
      const [feedData, setFeedData] = React.useState(null)
      const [upStats, setUpStats] = React.useState(null)
      const [biliMsg, setBiliMsg] = React.useState(null)
      const [cmdLine, setCmdLine] = React.useState('')
      const [cmdResult, setCmdResult] = React.useState(null)

      // 登录
      const [qr, setQr] = React.useState(null)
      const [loginKey, setLoginKey] = React.useState('')
      const [loginState, setLoginState] = React.useState('')
      const pollRef = React.useRef(null)

      // 生成
      const [script, setScript] = React.useState('')
      const [genBusy, setGenBusy] = React.useState(false)
      const [genResult, setGenResult] = React.useState(null)

      // 投稿
      const [title, setTitle] = React.useState('')
      const [desc, setDesc] = React.useState('')
      const [tid, setTid] = React.useState('124')
      const [tags, setTags] = React.useState('AI')
      const [upBusy, setUpBusy] = React.useState(false)
      const [upResult, setUpResult] = React.useState(null)
      const [videoPath, setVideoPath] = React.useState('')

      const refresh = async () => {
        try {
          const r = await jget('/status')
          if (r && r.ok) {
            setSt(r)
            setCfg(r.config || {})
            if (r.config) {
              setTitle((t) => t || r.config.lastTitle || '')
              setDesc((d) => d || r.config.lastDesc || '')
              setTid(String(r.config.tid ?? 124))
              setTags(r.config.tags || 'AI')
            }
          } else {
            setMsg({ type: 'err', text: (r && r.error) || '读状态失败' })
          }
        } catch (e) {
          setMsg({ type: 'err', text: String((e && e.message) || e) })
        }
        setLoading(false)
      }

      React.useEffect(() => {
        refresh()
        // bili-cli 状态（异步）
        jget('/bili/status').then((b) => setBiliState(b)).catch(() => setBiliState({ ok: false, installed: false }))
        return () => {
          if (pollRef.current) clearInterval(pollRef.current)
        }
      }, [])

      // ── bili-cli 调用（2026-10-22 加）──
      const runBili = async (args, tag) => {
        setBiliBusy(tag)
        setBiliMsg(null)
        try {
          return await jpost('/bili/run', { args })
        } catch (e) {
          setBiliMsg({ type: 'err', text: String((e && e.message) || e) })
          return null
        } finally {
          setBiliBusy('')
        }
      }

      const loadStats = async () => {
        const r = await runBili(['me', 'stats'], 'stats')
        if (r && r.ok) setStatsData(r.data)
        else setBiliMsg({ type: 'err', text: (r && (r.error || r.hint)) || '读不到创作中心数据' })
      }

      const loadHot = async () => {
        const r = await runBili(['hot', 'search'], 'hot')
        if (r && r.ok) setHotData(r.data)
        else setBiliMsg({ type: 'err', text: (r && (r.error || r.hint)) || '读不到热门' })
      }

      const loadFeed = async () => {
        const r = await runBili(['feed', 'notifications'], 'feed')
        if (r && r.ok) setFeedData(r.data)
        else setBiliMsg({ type: 'err', text: (r && (r.error || r.hint)) || '读不到消息' })
      }

      const loadUpStats = async () => {
        const r = await runBili(['upload', 'status'], 'upl')
        if (r && r.ok) setUpStats(r.data)
        else setBiliMsg({ type: 'err', text: (r && (r.error || r.hint)) || '读不到稿件状态' })
      }

      const runCmd = async () => {
        const line = cmdLine.trim()
        if (!line) return
        // 空格切分（够用：命令都是简单参数）
        const args = line.split(/\s+/)
        const r = await runBili(args, 'cmd')
        setCmdResult(r)
      }

      const stopPoll = () => {        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }

      const startLogin = async () => {
        setMsg(null)
        setLoginState('正在生成二维码…')
        setQr(null)
        const r = await jpost('/login/start', {})
        if (!r || !r.ok) {
          setLoginState('')
          setMsg({ type: 'err', text: (r && r.error) || '二维码生成失败' })
          return
        }
        setQr(r.qr || r.qrUrl)
        setLoginKey(r.key)
        setLoginState('请用 B站 App 扫码')

        stopPoll()
        pollRef.current = setInterval(async () => {
          try {
            const p = await jpost('/login/poll', { key: r.key })
            if (!p || !p.ok) {
              setLoginState('')
              stopPoll()
              setMsg({ type: 'err', text: (p && p.error) || '轮询失败' })
              return
            }
            if (p.state === 'ok') {
              stopPoll()
              setLoginState('')
              setQr(null)
              setMsg({ type: 'ok', text: `登录成功：${p.account?.name || ''}（uid ${p.account?.uid || '?'}）` })
              refresh()
            } else if (p.state === 'scanned') {
              setLoginState('已扫码，请在手机上确认')
            } else if (p.state === 'expired') {
              stopPoll()
              setLoginState('')
              setQr(null)
              setMsg({ type: 'err', text: '二维码过期了，重新点一次' })
            }
          } catch {
            /* 下次再拉 */
          }
        }, 2000)
      }

      const logout = async () => {
        await jpost('/logout', {})
        setMsg({ type: 'ok', text: '已退出（凭证删了）' })
        refresh()
      }

      const doGenerate = async () => {
        if (!script.trim() || genBusy) return
        setGenBusy(true)
        setGenResult(null)
        setMsg(null)
        const r = await jpost('/generate', { script, voice: cfg.voice })
        if (r && r.ok) {
          setGenResult(r)
          setVideoPath(r.file)
          setMsg({ type: 'ok', text: `视频生成好了：${(r.bytes / 1024).toFixed(0)} KB` })
        } else {
          setMsg({ type: 'err', text: (r && r.error) || '生成失败' })
        }
        setGenBusy(false)
      }

      const doUpload = async () => {
        if (upBusy) return
        if (!videoPath) {
          setMsg({ type: 'err', text: '先在上面生成一个视频' })
          return
        }
        if (!title.trim()) {
          setMsg({ type: 'err', text: '标题是空的' })
          return
        }
        setUpBusy(true)
        setUpResult(null)
        setMsg(null)
        const r = await jpost('/upload', {
          videoPath,
          title: title.trim(),
          desc,
          tid: Number(tid) || 124,
          tags,
        })
        if (r && r.ok) {
          setUpResult(r)
          setMsg({ type: 'ok', text: '投稿成功！' })
          // 记住标题/简介
          await jpost('/config', { lastTitle: title, lastDesc: desc })
        } else {
          setMsg({ type: 'err', text: (r && r.error) || '投稿失败' })
        }
        setUpBusy(false)
      }

      if (loading) return h('div', { 'data-fst': '' }, h('div', { 'data-fst-note': '' }, '读取中…'))

      const loggedIn = st.loggedIn === true

      return h('div', { 'data-fst': '' },

        // ── 账号 ──
        h(Section, { title: 'B站账号（发视频专用的号）' },
          h('div', { 'data-fst-note': '' },
            '这里的登录跟「刷B站」那个号是分开的 —— 用另一个号发视频，互不影响。'),
          loggedIn
            ? h('div', { 'data-fst-acct': '' },
                h('div', {}, `已登录：${st.account?.name || '(未知)'}`),
                h('div', { 'data-fst-note': '' }, `uid ${st.account?.uid || '?'}`),
              )
            : h('div', { 'data-fst-note': '' }, '还没登录'),
          h('div', { 'data-fst-row': '' },
            h('button', {
              'data-fst-btn': '', 'data-primary': '',
              onClick: startLogin,
            }, loggedIn ? '换一个号登录' : '扫码登录'),
            loggedIn
              ? h('button', { 'data-fst-btn': '', 'data-danger': '', onClick: logout }, '退出')
              : null,
          ),
          loginState ? h('div', { 'data-fst-note': '' }, loginState) : null,
          qr
            ? h('div', { 'data-fst-qr': '' },
                h('img', { src: qr, alt: '二维码' }),
                h('div', { 'data-fst-note': '' },
                  '用 B站 App 扫这个码。',
                  h('br'),
                  '⚠️ 这个二维码只给发视频的号用，别扫错号。',
                ),
              )
            : null,
        ),

        // ── 生成 ──
        h(Section, { title: '生成视频' },
          h(Field, {
            label: '脚本',
            note: '第一行当标题，剩下的当正文。会自动配成语音 + 画面。',
          },
            h('textarea', {
              'data-fst-area': '',
              value: script,
              placeholder: '第一行写标题\n下面写正文，每行一句\n会自动配成语音和画面',
              onChange: (e) => setScript(e.target.value),
            }),
          ),
          h('div', { 'data-fst-row': '' },
            h('button', {
              'data-fst-btn': '', 'data-primary': '',
              disabled: genBusy || !script.trim(),
              onClick: doGenerate,
            }, genBusy ? '生成中…' : '生成视频'),
            genResult
              ? h('div', { 'data-fst-ok': '', style: { flex: 1 } },
                  `${genResult.file}（${(genResult.bytes / 1024).toFixed(0)} KB）`)
              : h('div', { 'data-fst-note': '', style: { flex: 1 } },
                  st.python ? 'Python 环境就绪' : '⚠️ 找不到 Python（先装「刷B站」）'),
          ),
        ),

        // ── 投稿 ──
        h(Section, { title: '投稿到 B站' },
          h(Field, { label: '视频文件', note: '生成之后自动填；也可以手动填已有文件的路径。' },
            h('input', {
              'data-fst-input': '', type: 'text',
              value: videoPath,
              placeholder: '例如 C:\\Users\\...\\out\\xxx.mp4',
              onChange: (e) => setVideoPath(e.target.value),
            }),
          ),
          h(Field, { label: '标题（最多 80 字）' },
            h('input', {
              'data-fst-input': '', type: 'text',
              value: title,
              placeholder: '视频标题',
              onChange: (e) => setTitle(e.target.value),
            }),
          ),
          h(Field, { label: '简介' },
            h('textarea', {
              'data-fst-area': '', style: { minHeight: '70px' },
              value: desc,
              placeholder: '简介（可留空）',
              onChange: (e) => setDesc(e.target.value),
            }),
          ),
          h('div', { 'data-fst-row': '' },
            h('div', { 'data-fst-grow': '' },
              h('div', { 'data-fst-label': '' }, '分区 ID'),
              h('div', { 'data-fst-note': '' }, '124=社科 188=科技 230=生活 21=日常'),
              h('input', {
                'data-fst-input': '', type: 'text',
                value: tid,
                onChange: (e) => setTid(e.target.value),
                style: { width: '110px' },
              }),
            ),
            h('div', { 'data-fst-grow': '' },
              h('div', { 'data-fst-label': '' }, '标签（逗号分隔）'),
              h('div', { 'data-fst-note': '' }, '至少一个'),
              h('input', {
                'data-fst-input': '', type: 'text',
                value: tags,
                onChange: (e) => setTags(e.target.value),
              }),
            ),
          ),
          h('div', { 'data-fst-row': '' },
            h('button', {
              'data-fst-btn': '', 'data-primary': '',
              disabled: upBusy || !loggedIn,
              onClick: doUpload,
            }, upBusy ? '投稿中…' : '投稿'),
            !loggedIn ? h('div', { 'data-fst-note': '', style: { flex: 1 } }, '先扫码登录才能投稿') : null,
          ),
          upResult
            ? h('div', { 'data-fst-log': '' }, JSON.stringify(upResult, null, 2))
            : null,
        ),

        // ── 提示 ──
        msg
          ? h('div', { [msg.type === 'ok' ? 'data-fst-ok' : 'data-fst-err']: '' }, msg.text)
          : null,

        // ══ bili-cli 工具集（2026-10-22 加）══════════════════════════════
        // 这些是 bili-cli 的能力，本插件通过后端转发调用，不重复实现。
        biliState && !biliState.installed
          ? h('div', { 'data-fst-note': '' },
              '⚠️ 没找到 bili-cli —— 下面的工具不可用。装法：pip install bili-agent')
          : null,

        // ── 创作中心 ──
        h(Section, { title: '创作中心' },
          h('div', { 'data-fst-note': '' },
            biliState?.installed
              ? `数据来自 B站 创作中心，次日更新${biliState.auth?.data?.user ? `（当前号：${biliState.auth.data.user.name} Lv${biliState.auth.data.user.level}）` : ''}`
              : '检查 bili-cli 中…'),
          h('div', { 'data-fst-row': '' },
            h('button', {
              'data-fst-btn': '', 'data-primary': '',
              disabled: !biliState?.installed || biliBusy === 'stats',
              onClick: loadStats,
            }, biliBusy === 'stats' ? '读取中…' : '看这周数据'),
          ),
          statsData
            ? h('div', { 'data-fst-sub': '' },
                h('div', { 'data-fst-row': '' },
                  h('div', { 'data-fst-grow': '' },
                    h('div', { 'data-fst-label': '' }, '播放'),
                    h('div', { 'data-fst-note': '' },
                      `${statsData.plays?.now ?? '?'}（上周 ${statsData.plays?.previous ?? '?'}）`)),
                  h('div', { 'data-fst-grow': '' },
                    h('div', { 'data-fst-label': '' }, '访客'),
                    h('div', { 'data-fst-note': '' },
                      `${statsData.visitors?.now ?? '?'}（上周 ${statsData.visitors?.previous ?? '?'}）`)),
                  h('div', { 'data-fst-grow': '' },
                    h('div', { 'data-fst-label': '' }, '涨粉'),
                    h('div', { 'data-fst-note': '' },
                      `+${statsData.new_fans?.now ?? 0}（共 ${statsData.fans?.total ?? '?'}）`)),
                ),
                h('div', { 'data-fst-note': '' },
                  `播放端：手机 ${statsData.play_platforms_percent?.mobile ?? '?'}% · PC ${statsData.play_platforms_percent?.pc ?? '?'}%`),
                h('div', { 'data-fst-note': '' },
                  `超过相似 UP：播放 ${statsData.beats_similar_ups_percent?.play ?? '?'}% · 点赞 ${statsData.beats_similar_ups_percent?.like ?? '?'}%`),
                Array.isArray(statsData.top_videos_yesterday) && statsData.top_videos_yesterday.length
                  ? h('div', {},
                      h('div', { 'data-fst-label': '', style: { marginTop: '6px' } }, '昨日播放最多的'),
                      ...statsData.top_videos_yesterday.slice(0, 3).map((v, i) =>
                        h('div', { key: `tv-${i}`, 'data-fst-note': '' },
                          `· ${v.title} —— ${v.plays} 播放`)))
                  : null,
              )
            : null,
        ),

        // ── 稿件状态 ──
        h(Section, { title: '稿件状态' },
          h('div', { 'data-fst-note': '' }, '看最近投的稿审核到哪了、播放多少。'),
          h('div', { 'data-fst-row': '' },
            h('button', {
              'data-fst-btn': '',
              disabled: !biliState?.installed || biliBusy === 'upl',
              onClick: loadUpStats,
            }, biliBusy === 'upl' ? '读取中…' : '看稿件状态'),
          ),
          upStats
            ? h('div', { 'data-fst-log': '' }, JSON.stringify(upStats, null, 2).slice(0, 2000))
            : null,
        ),

        // ── 消息通知 ──
        h(Section, { title: '消息通知' },
          h('div', { 'data-fst-note': '' }, '谁回了我、谁 @ 了我、未读数多少。'),
          h('div', { 'data-fst-row': '' },
            h('button', {
              'data-fst-btn': '',
              disabled: !biliState?.installed || biliBusy === 'feed',
              onClick: loadFeed,
            }, biliBusy === 'feed' ? '读取中…' : '看消息'),
          ),
          feedData
            ? h('div', { 'data-fst-log': '' }, JSON.stringify(feedData, null, 2).slice(0, 2000))
            : null,
        ),

        // ── 热门 ──
        h(Section, { title: '热门' },
          h('div', { 'data-fst-note': '' }, '看现在 B站 在热什么（搜什么、什么火）。'),
          h('div', { 'data-fst-row': '' },
            h('button', {
              'data-fst-btn': '',
              disabled: !biliState?.installed || biliBusy === 'hot',
              onClick: loadHot,
            }, biliBusy === 'hot' ? '读取中…' : '看热搜'),
          ),
          Array.isArray(hotData?.items) && hotData.items.length
            ? h('div', { 'data-fst-sub': '' },
                ...hotData.items.slice(0, 10).map((it, i) =>
                  h('div', { key: `hot-${i}`, 'data-fst-note': '' },
                    `${it.rank}. ${it.title || it.keyword} —— ${it.heat} 热度`)),
              )
            : null,
        ),

        // ── 高级：直接跑 bili 命令 ──
        h(Section, { title: '更多命令（高级）' },
          h('div', { 'data-fst-note': '' },
            'bili-cli 有 20 多个命令，这里能直接跑。例：danmaku send BV号 内容 / dynamic post "文字" / owner set / comment pin BV号 rpid'),
          h('div', { 'data-fst-row': '' },
            h('input', {
              'data-fst-input': '', type: 'text',
              value: cmdLine,
              placeholder: '例如：hot rank  或  me show',
              onChange: (e) => setCmdLine(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') runCmd() },
            }),
            h('button', {
              'data-fst-btn': '',
              disabled: !biliState?.installed || !cmdLine.trim() || biliBusy === 'cmd',
              onClick: runCmd,
            }, biliBusy === 'cmd' ? '跑…' : '执行'),
          ),
          cmdResult
            ? h('div', { 'data-fst-log': '' }, JSON.stringify(cmdResult, null, 2).slice(0, 3000))
            : null,
        ),

        biliMsg
          ? h('div', { [biliMsg.type === 'ok' ? 'data-fst-ok' : 'data-fst-err']: '' }, biliMsg.text)
          : null,

        // ── 署名 ──
        h('div', {
          style: {
            fontSize: '12px',
            textAlign: 'center',
            opacity: '.55',
            paddingTop: '4px',
          },
        }, 'B站创作台 · 大肥鱼做的'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          const style = document.createElement('style')
          style.textContent = CSS
          style.setAttribute('data-plugin-css', 'feiyu-bili-studio')
          document.head.appendChild(style)
          ctx.effect(() => () => style.remove(), 'feiyu-bili-studio: 样式')
        } catch { /* 样式失败不影响功能 */ }

        try {
          const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
          if (!slots) return
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: 'bili-studio', order: 27, label: 'B站创作台' },
            () => h(Panel),
          ))
        } catch {
          /* 注册失败只是这页不出现 */
        }
      },
    }
  },
})
