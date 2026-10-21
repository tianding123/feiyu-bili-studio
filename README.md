# feiyu-bili-studio

DSH 插件：**B站创作台** —— 用另一个号（发视频专用的号）做视频、投稿。

## 功能

- **独立扫码登录** —— 跟「刷B站」那个号完全隔离，凭证存在 `~/.dsh/bili-studio/bili_credential.json`
- **生成视频** —— 读稿 → 配音（edge-tts）→ 画面 → 带**底部字幕**的 mp4
- **投稿** —— 调 bilibili_api 的 VideoUploader，自动抽帧当封面
- **创作中心 / 稿件状态 / 消息通知 / 热门** —— 走 bili-cli（如果装了）

## 字幕是怎么做的

字幕不是画在图上的，是**烧在视频底部的**（用了 `subtitles` 滤镜 + libass）。

核心在这三行：

```python
from edge_tts import SubMaker
# ⚠️ 必须显式传 boundary='WordBoundary'
com = edge_tts.Communicate(text, voice, boundary="WordBoundary")
async for chunk in com.stream():
    if chunk["type"] == "WordBoundary":
        sub.feed(chunk)          # 每个词带精确的 offset / duration
srt = sub.get_srt()              # → 时间轴精确的 srt
```

然后按句合并（句末标点断句 / 超 14 字断句），再交给 ffmpeg：

```
-vf "scale=1280:720,subtitles='sub.srt':force_style='FontSize=17,Alignment=2,MarginV=28'"
```

## 踩过的坑

1. **`boundary` 默认是 `SentenceBoundary`** —— 不显式传 `WordBoundary` 的话，流里根本不会有 WordBoundary 事件，SubMaker 收到 0 条，srt 是空的。
2. **Windows 路径要转义** —— srt 路径里的 `C:` 冒号会让 ffmpeg 滤镜解析失败，得写成 `C\:/...`。
3. **字幕别超过 14 个汉字** —— 1280 宽下超过会被裁掉。
4. **TTS 别念标题行** —— 标题已经在画面上了，再念一遍字幕会重复。
5. **B站 投稿接口传不了 srt 字幕**（bilibili_api 源码注释原话：「莫名其妙没法上传 srt 字幕」），所以只能烧进画面。

## 安装

从本仓库装即可。

## License

MIT