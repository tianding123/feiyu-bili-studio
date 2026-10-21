"""feiyu-bili-studio —— 生成视频 / 投稿（Python 半边）

两个子命令：
  generate  脚本 -> 配音(edge-tts) + 画面(PIL) -> mp4(ffmpeg)
  upload    调 bilibili_api.video_uploader 投稿

输出：最后一行永远是一行 JSON（{"ok": true/false, ...}），给 index.js 解析。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
]


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False))


def find_font(bold=False):
    from PIL import ImageFont  # noqa: F401

    order = FONT_CANDIDATES[::-1] if bold else FONT_CANDIDATES
    for p in order:
        if os.path.exists(p):
            return p
    return ""


def find_ffmpeg():
    """优先用 PATH 里的，其次试常见的 Windows 安装位置。"""
    import shutil

    p = shutil.which("ffmpeg")
    if p:
        return p
    for c in (r"D:\ffmpeg\bin\ffmpeg.exe", r"C:\ffmpeg\bin\ffmpeg.exe"):
        if os.path.exists(c):
            return c
    return ""


# ────────────────────────── generate ──────────────────────────


async def _tts_with_srt(text: str, out_mp3: str, out_srt: str, voice: str):
    """配音 + 同时生成精确时间轴的字幕。

    2026-10-22 改（照 10/20 那条视频的做法）：
       edge_tts 在流式合成时会发 WordBoundary 事件，每个字/词带精确的
       offset / duration（单位 100ns）。喂给 SubMaker 就能得到逐句对齐的 srt，
       不用自己估算时间。

    返回 srt 条数；失败返回 0。
    """
    import edge_tts
    from edge_tts import SubMaker

    sub = SubMaker()
    # ⚠️ edge_tts 的 boundary 默认是 'SentenceBoundary' —— 不显式传 'WordBoundary'
    #    的话，流里根本不会出现 WordBoundary 事件，SubMaker 收到 0 条，srt 是空的。
    #    （2026-10-22 踩过：audio 有 32 块、WordBoundary 0 块、srt 长度 0）
    com = edge_tts.Communicate(text, voice, rate="+0%", boundary="WordBoundary")

    audio = bytearray()
    words = []          # [(text, offset_100ns, duration_100ns), ...]
    async for chunk in com.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            sub.feed(chunk)
            words.append((chunk.get("text", ""), chunk.get("offset", 0), chunk.get("duration", 0)))

    with open(out_mp3, "wb") as f:
        f.write(bytes(audio))

    # ── 把「按词」的片段合并成「按句」──
    # 规则：遇到中文句末标点（。！？；\n）就断句；或者单条太长（> 22 字）也断。
    srt = _words_to_srt(words)
    if not srt:
        # 合不出句子就退回 edge_tts 自己的
        srt = sub.get_srt()

    with open(out_srt, "w", encoding="utf-8", newline="") as f:
        f.write(srt)

    return srt.count("-->")


def _fmt_ts(t100ns: int) -> str:
    """100ns 单位 → HH:MM:SS,mmm"""
    ms = int(t100ns / 10000)
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


def _words_to_srt(words, max_chars: int = 14) -> str:
    """把逐词时间轴合并成「按句」的 srt。"""
    if not words:
        return ""

    END_PUNCT = "。！？!?；;…\n"
    groups = []   # [(text, start, end), ...]
    cur_text = ""
    cur_start = None
    cur_end = None

    for text, off, dur in words:
        if not text:
            continue
        if cur_start is None:
            cur_start = off
        cur_text += text
        cur_end = off + dur

        should_break = False
        # 1) 句末标点
        if any(ch in END_PUNCT for ch in text):
            should_break = True
        # 2) 太长
        elif len(cur_text) >= max_chars:
            should_break = True
        # 3) 逗号后面且已经够长
        elif any(ch in "，,、" for ch in text) and len(cur_text) >= 8:
            should_break = True

        if should_break:
            groups.append((cur_text.strip(), cur_start, cur_end))
            cur_text, cur_start, cur_end = "", None, None

    if cur_text.strip() and cur_start is not None:
        groups.append((cur_text.strip(), cur_start, cur_end))

    lines = []
    for i, (t, a, b) in enumerate(groups, 1):
        lines.append(str(i))
        lines.append("%s --> %s" % (_fmt_ts(a), _fmt_ts(b)))
        lines.append(t)
        lines.append("")
    return "\n".join(lines)


def _wrap(draw, text, font, max_width):
    """按像素宽度折行（中文没有空格，只能逐字量）。"""
    lines = []
    for para in text.split("\n"):
        if not para:
            lines.append("")
            continue
        cur = ""
        for ch in para:
            trial = cur + ch
            w = draw.textlength(trial, font=font)
            if w > max_width and cur:
                lines.append(cur)
                cur = ch
            else:
                cur = trial
        if cur:
            lines.append(cur)
    return lines


def _make_frame(title: str, body: str, width: int, height: int, image_path: str = "",
                caption_mode: bool = False) -> str:
    """画一张标题图（或标题+正文图），返回临时 png 路径。

    caption_mode=True 表示正文改由底部字幕显示，画面只放标题：
      · 有图时：截图铺满，标题压在顶部渐变带上（底部留给字幕）
      · 没图时：深色背景 + 居中标题

    image_path 给了的话：把它铺成背景（等比裁切填满），上面叠一层深色渐变。
    """
    from PIL import Image, ImageDraw, ImageFont

    has_bg = False
    text_top = None

    if image_path and os.path.exists(image_path):
        try:
            # ── 有图：上面放截图、下面留深色写文字（不重叠，避免两套字打架）──
            img = Image.new("RGB", (width, height), (14, 16, 24))
            draw = ImageDraw.Draw(img)

            shot_h = int(height * 0.50)
            pad = int(width * 0.04)
            base = Image.open(image_path).convert("RGB")
            sw, sh = base.size
            scale = min((width - pad * 2) / sw, shot_h / sh)
            nw, nh = max(1, int(sw * scale)), max(1, int(sh * scale))
            shot = base.resize((nw, nh), Image.LANCZOS)
            sx = (width - nw) // 2
            sy = pad
            img.paste(shot, (sx, sy))
            draw.rectangle([(sx - 1, sy - 1), (sx + nw, sy + nh)], outline=(70, 80, 110), width=2)

            has_bg = True
            text_top = sy + nh + int(height * 0.05)
        except Exception:
            has_bg = False

    if not has_bg:
        img = Image.new("RGB", (width, height), (18, 20, 28))
        draw = ImageDraw.Draw(img)

        # 顶部渐变色块
        for y in range(int(height * 0.28)):
            alpha = 1 - y / max(1, int(height * 0.28))
            r = int(24 + 40 * alpha)
            g = int(30 + 60 * alpha)
            b = int(48 + 90 * alpha)
            draw.rectangle([(0, y), (width, y + 1)], fill=(r, g, b))
        text_top = int(height * 0.10)

    font_path = find_font()
    bold_path = find_font(bold=True) or font_path

    t_size = max(26, int(width * 0.046))
    b_size = max(15, int(width * 0.022))

    try:
        t_font = ImageFont.truetype(bold_path, t_size) if bold_path else ImageFont.load_default()
        b_font = ImageFont.truetype(font_path, b_size) if font_path else ImageFont.load_default()
    except Exception:
        t_font = ImageFont.load_default()
        b_font = ImageFont.load_default()

    margin = int(width * 0.07)
    max_w = width - margin * 2

    # 有图时文字从截图下面开始，并且字号收小一点（下面空间少了）
    if has_bg:
        t_size = max(22, int(width * 0.036))
        b_size = max(13, int(width * 0.018))
        try:
            t_font = ImageFont.truetype(bold_path, t_size) if bold_path else ImageFont.load_default()
            b_font = ImageFont.truetype(font_path, b_size) if font_path else ImageFont.load_default()
        except Exception:
            pass

    # 标题
    y = text_top if text_top is not None else int(height * 0.10)
    for line in _wrap(draw, title or "", t_font, max_w)[:2 if has_bg else 4]:
        draw.text((margin, y), line, font=t_font, fill=(245, 247, 252))
        y += int(t_size * 1.35)

    # 分隔线
    y += int(height * 0.015)
    draw.line([(margin, y), (width - margin, y)], fill=(90, 120, 180), width=2)
    y += int(height * 0.03)

    # 正文
    for line in _wrap(draw, body or "", b_font, max_w):
        if y > height - int(height * 0.04):
            draw.text((margin, y), "…", font=b_font, fill=(150, 160, 180))
            break
        draw.text((margin, y), line, font=b_font, fill=(198, 208, 224))
        y += int(b_size * 1.4)

    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp.close()
    img.save(tmp.name, "PNG")
    return tmp.name


def cmd_generate(args):
    try:
        from PIL import Image  # noqa: F401
    except Exception as e:
        emit({"ok": False, "error": "没装 Pillow：%s" % e})
        return 1

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        emit({"ok": False, "error": "找不到 ffmpeg（PATH 里没有，常见位置也没找到）"})
        return 1

    script = (args.script or "").strip()
    if not script:
        emit({"ok": False, "error": "脚本是空的"})
        return 1

    # 上面几行当标题，剩下的当正文
    lines = [ln.strip() for ln in script.split("\n") if ln.strip()]
    title = lines[0][:40] if lines else "无标题"
    body = "\n".join(lines[1:]) if len(lines) > 1 else ""

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    tmpdir = tempfile.mkdtemp(prefix="studio-")
    mp3 = os.path.join(tmpdir, "voice.mp3")

    try:
        # ① 配音 + 字幕（一次搞定，时间轴是精确的）
        srt_path = os.path.join(tmpdir, "sub.srt")
        srt_count = 0
        try:
            # ⚠️ 念正文（不含标题行）—— 标题已经在画面上了，
            #    再念一遍会让底部字幕第一句变成"标题+正文"重复
            speak_text = body.strip() or script
            srt_count = asyncio.run(_tts_with_srt(speak_text, mp3, srt_path, args.voice))
        except Exception as e:
            emit({"ok": False, "error": "配音失败：%s" % e})
            return 1
        if not os.path.exists(mp3) or os.path.getsize(mp3) < 1000:
            emit({"ok": False, "error": "配音生成的音频异常（文件太小）"})
            return 1

        # ② 画面（不再画正文 —— 正文交给底部字幕；有图时只画标题在下方）
        try:
            png = _make_frame(title, "" if srt_count > 0 else body,
                              args.width, args.height, getattr(args, "image", "") or "",
                              caption_mode=(srt_count > 0))
        except Exception as e:
            emit({"ok": False, "error": "画封面失败：%s" % e})
            return 1

        # ③ 合成：一张图铺满整个音频时长
        #    有字幕时加 subtitles 滤镜，把 srt 烧到画面底部
        vf = "scale=%d:%d" % (args.width, args.height)
        if srt_count > 0 and os.path.exists(srt_path) and os.path.getsize(srt_path) > 20:
            # 路径里可能有冒号（Windows 盘符）—— 必须先转义，否则滤镜解析失败
            srt_esc = srt_path.replace("\\", "/").replace(":", "\\:")
            style = (
                "FontName=Microsoft YaHei,FontSize=17,"
                "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,"
                "BorderStyle=1,Outline=1,Shadow=0,"
                "Alignment=2,MarginV=28"
            )
            vf += ",subtitles='%s':force_style='%s'" % (srt_esc, style)

        cmd = [
            ffmpeg,
            "-y",
            "-loop", "1",
            "-i", png,
            "-i", mp3,
            "-c:v", "libx264",
            "-tune", "stillimage",
            "-c:a", "aac",
            "-b:a", "128k",
            "-pix_fmt", "yuv420p",
            "-shortest",
            "-vf", vf,
            str(out),
        ]
        r = subprocess.run(cmd, capture_output=True, timeout=600)
        if r.returncode != 0:
            emit({"ok": False, "error": "ffmpeg 合成失败：%s" % r.stderr.decode("utf-8", "replace")[-600:]})
            return 1

        size = out.stat().st_size if out.exists() else 0
        if size < 10000:
            emit({"ok": False, "error": "生成的视频太小（%d 字节）" % size})
            return 1

        emit({
            "ok": True,
            "file": str(out),
            "bytes": size,
            "title": title,
            "voice": args.voice,
        })
        return 0

    finally:
        try:
            import shutil

            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


# ────────────────────────── upload ──────────────────────────


def cmd_upload(args):
    try:
        from bilibili_api import Credential
        from bilibili_api.video_uploader import VideoUploader, VideoUploaderPage, VideoMeta
    except Exception as e:
        emit({"ok": False, "error": "bilibili_api 导入失败：%s" % e})
        return 1

    video = Path(args.video)
    if not video.exists():
        emit({"ok": False, "error": "视频文件不存在：%s" % video})
        return 1

    cred_file = Path(args.cred)
    try:
        j = json.loads(cred_file.read_text(encoding="utf-8"))
    except Exception as e:
        emit({"ok": False, "error": "读凭证失败：%s（先扫码登录）" % e})
        return 1

    if not j.get("sessdata"):
        emit({"ok": False, "error": "凭证里没有 sessdata（先扫码登录）"})
        return 1

    cred = Credential(
        sessdata=j.get("sessdata", ""),
        bili_jct=j.get("bili_jct", ""),
        buvid3=j.get("buvid3", ""),
        dedeuserid=j.get("dedeuserid", ""),
    )

    title = (args.title or "").strip()[:80]
    if not title:
        emit({"ok": False, "error": "标题是空的"})
        return 1

    tags = [t.strip() for t in (args.tags or "").split(",") if t.strip()] or ["AI"]

    # cover 是必填的（VideoMeta 要求）。没给就从视频里抽一帧当封面。
    cover = args.cover or ""
    if not cover:
        ffmpeg = find_ffmpeg()
        if ffmpeg:
            tmpcov = os.path.join(tempfile.mkdtemp(prefix="studiocov-"), "cover.jpg")
            rc = subprocess.run(
                [ffmpeg, "-y", "-ss", "1", "-i", str(video), "-frames:v", "1", "-q:v", "3", tmpcov],
                capture_output=True,
                timeout=120,
            )
            if rc.returncode == 0 and os.path.exists(tmpcov) and os.path.getsize(tmpcov) > 1000:
                cover = tmpcov

    def go():
        meta = VideoMeta(
            tid=int(args.tid),
            title=title,
            desc=(args.desc or "")[:2000],
            cover=cover,                # 路径也行（库内部会读文件上传）
            tags=",".join(tags),        # ⚠️ 参数名是 tags，不是 tag
            no_reprint=bool(args.no_reprint),
        )
        page = VideoUploaderPage(path=str(video), title=title)
        uploader = VideoUploader(pages=[page], meta=meta, credential=cred)
        return uploader.start()

    try:
        result = asyncio.run(go())
    except Exception as e:
        emit({"ok": False, "error": "投稿失败：%s" % e})
        return 1

    emit({"ok": True, "result": result})
    return 0


def main():
    ap = argparse.ArgumentParser(description="feiyu-bili-studio 的 Python 后端")
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", help="脚本 -> 视频")
    g.add_argument("--script", required=True, help="脚本全文（第一行当标题）")
    g.add_argument("--out", required=True, help="输出 mp4 路径")
    g.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    g.add_argument("--width", type=int, default=1280)
    g.add_argument("--height", type=int, default=720)
    g.add_argument("--image", default="", help="背景图路径（给了就把图铺成背景，文字压在上面）")
    g.set_defaults(func=cmd_generate)

    u = sub.add_parser("upload", help="投稿到 B站")
    u.add_argument("--video", required=True)
    u.add_argument("--title", required=True)
    u.add_argument("--desc", default="")
    u.add_argument("--tid", default="124")
    u.add_argument("--tags", default="AI")
    u.add_argument("--cover", default="")
    u.add_argument("--cred", required=True, help="凭证 json 路径")
    u.add_argument("--no-reprint", dest="no_reprint", action="store_true", default=True)
    u.set_defaults(func=cmd_upload)

    args = ap.parse_args()
    try:
        sys.exit(args.func(args) or 0)
    except Exception as e:
        emit({"ok": False, "error": "未处理异常：%s" % e})
        sys.exit(1)


if __name__ == "__main__":
    main()
