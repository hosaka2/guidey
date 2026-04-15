"""高品質RAGデータ作成パイプライン.

3つのモード:
  search: YouTube自動検索 → 上位N件をインジェスト
  batch:  JSONファイルからバッチインジェスト
  url:    単一URLをインジェスト

使い方:
  uv run python -m scripts.ingest_pipeline search "Mac 初期設定" --mode diy --count 5
  uv run python -m scripts.ingest_pipeline batch sources.json
  uv run python -m scripts.ingest_pipeline url "https://youtube.com/watch?v=XXX" --mode diy

事前準備:
  brew install yt-dlp ffmpeg
  ollama pull gemma4:42b nomic-embed-text
"""

import argparse
import asyncio
import json
import logging
import re
import subprocess
from pathlib import Path

from src.config import settings
from src.infrastructure.llm.ollama import OllamaHQClient
from src.infrastructure.rag.bm25 import BM25Index
from src.infrastructure.rag.embeddings import EmbeddingClient
from src.infrastructure.rag.milvus import MilvusRAGClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

QUALITY_THRESHOLD = 0.3
CHUNK_DURATION_SEC = 300  # 5分ごとに字幕チャンク分割
CANDIDATE_FRAMES_PER_STEP = 8  # フレーム候補数


# ============================================================
# Phase A: データ収集
# ============================================================


def extract_video_id(url: str) -> str:
    patterns = [
        r"v=([a-zA-Z0-9_-]{11})",
        r"youtu\.be/([a-zA-Z0-9_-]{11})",
        r"shorts/([a-zA-Z0-9_-]{11})",
    ]
    for p in patterns:
        m = re.search(p, url)
        if m:
            return m.group(1)
    raise ValueError(f"YouTube video ID を抽出できません: {url}")


def search_youtube(topic: str, count: int, mode: str) -> list[dict]:
    """YouTube検索 → メタデータ取得 → フィルタ → 上位N件."""
    logger.info(f"[Search] '{topic}' で検索中 (候補{count * 3}件)...")
    search_count = count * 3

    result = subprocess.run(
        [
            "yt-dlp",
            f"ytsearch{search_count}:{topic}",
            "--dump-json",
            "--no-download",
            "--flat-playlist",
        ],
        capture_output=True,
        text=True,
    )

    candidates = []
    for line in result.stdout.strip().split("\n"):
        if not line:
            continue
        try:
            info = json.loads(line)
            vid = info.get("id", "")
            duration = info.get("duration") or 0
            view_count = info.get("view_count") or 0
            title = info.get("title", "")

            # フィルタ: 5-30分
            if duration < 300 or duration > 1800:
                continue

            candidates.append({
                "url": f"https://www.youtube.com/watch?v={vid}",
                "video_id": vid,
                "title": title,
                "duration": duration,
                "view_count": view_count,
                "mode": mode,
            })
        except json.JSONDecodeError:
            continue

    # 再生回数でソート
    candidates.sort(key=lambda x: x["view_count"], reverse=True)
    selected = candidates[:count]

    for c in selected:
        logger.info(f"  {c['title'][:40]}  views={c['view_count']:,}  dur={c['duration']}s")

    return selected


def download_subtitles(url: str, tmp_dir: Path) -> Path | None:
    """字幕ダウンロード。なければ None."""
    try:
        subprocess.run(
            ["yt-dlp", "--write-auto-sub", "--sub-lang", "ja", "--sub-format", "vtt",
             "--skip-download", "-o", str(tmp_dir / "video"), url],
            check=True, capture_output=True,
        )
        vtt_files = list(tmp_dir.glob("*.vtt"))
        return vtt_files[0] if vtt_files else None
    except subprocess.CalledProcessError:
        return None


def download_video(url: str, tmp_dir: Path) -> Path | None:
    try:
        output = tmp_dir / "video.mp4"
        subprocess.run(
            ["yt-dlp", "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4",
             "-o", str(output), url],
            check=True, capture_output=True,
        )
        if output.exists():
            return output
        mp4s = list(tmp_dir.glob("video*"))
        return mp4s[0] if mp4s else None
    except subprocess.CalledProcessError:
        return None


def is_already_ingested(video_id: str, mode: str) -> bool:
    """Milvusに既にインジェスト済みかチェック."""
    try:
        milvus = MilvusRAGClient()
        steps = milvus.get_all_steps(mode, video_id)
        return len(steps) > 0
    except Exception:
        return False


# ============================================================
# Phase B: 高品質ステップ分解
# ============================================================


def parse_vtt(vtt_path: Path) -> list[dict]:
    content = vtt_path.read_text(encoding="utf-8")
    segments = []
    current_text = ""
    current_start = ""
    current_end = ""

    for line in content.split("\n"):
        line = line.strip()
        ts_match = re.match(
            r"(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})", line
        )
        if ts_match:
            if current_text.strip():
                segments.append({"start": current_start, "end": current_end, "text": current_text.strip()})
            current_start = ts_match.group(1)
            current_end = ts_match.group(2)
            current_text = ""
        elif line and not line.startswith("WEBVTT") and not line.startswith("NOTE"):
            clean = re.sub(r"<[^>]+>", "", line)
            if clean:
                current_text += clean + " "

    if current_text.strip():
        segments.append({"start": current_start, "end": current_end, "text": current_text.strip()})

    # 重複除去
    deduped = []
    seen = set()
    for seg in segments:
        if seg["text"] not in seen:
            seen.add(seg["text"])
            deduped.append(seg)
    return deduped


def ts_to_sec(ts) -> float:
    if isinstance(ts, (int, float)):
        return float(ts)
    if not ts:
        return 0.0
    ts = str(ts)
    parts = ts.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        elif len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        return float(parts[0])
    except (ValueError, IndexError):
        return 0.0


def chunk_subtitles(segments: list[dict], chunk_sec: int = CHUNK_DURATION_SEC) -> list[str]:
    """字幕を時間ベースでチャンク分割."""
    if not segments:
        return []

    chunks = []
    current_chunk = []
    chunk_start = ts_to_sec(segments[0]["start"])

    for seg in segments:
        seg_start = ts_to_sec(seg["start"])
        if seg_start - chunk_start >= chunk_sec and current_chunk:
            text = "\n".join(f"[{s['start']}] {s['text']}" for s in current_chunk)
            chunks.append(text)
            current_chunk = []
            chunk_start = seg_start
        current_chunk.append(seg)

    if current_chunk:
        text = "\n".join(f"[{s['start']}] {s['text']}" for s in current_chunk)
        chunks.append(text)

    return chunks


async def two_stage_segmentation(
    subtitle_chunks: list[str], llm: OllamaHQClient, mode: str
) -> list[dict]:
    """2段階ステップ分解: チャンク別分割 → 統合."""
    mode_label = "DIY作業" if mode == "diy" else "料理"
    logger.info(f"  Stage 1: {len(subtitle_chunks)}チャンクを個別分割中...")

    # Stage 1: 各チャンクを個別にステップ分割
    all_raw_steps = []
    for i, chunk in enumerate(subtitle_chunks):
        prompt = f"""以下はYouTube{mode_label}動画の字幕テキスト（一部分）です。
この部分に含まれる作業ステップを抽出してください。

字幕:
{chunk}

JSON配列のみ返してください:
[{{"text": "具体的な作業指示", "start_time": "HH:MM:SS", "end_time": "HH:MM:SS"}}]

ルール:
- 各ステップは具体的な作業アクション
- 前置き・雑談は省略
- 3〜5ステップ程度"""

        try:
            response = await llm.generate_text(prompt)
            match = re.search(r"\[[\s\S]*\]", response)
            if match:
                steps = json.loads(match.group())
                all_raw_steps.extend(steps)
        except Exception:
            logger.debug(f"  チャンク{i+1} 分割失敗")

    logger.info(f"  Stage 1 完了: {len(all_raw_steps)} raw steps")

    if not all_raw_steps:
        return []

    # Stage 2: 統合・精緻化
    logger.info("  Stage 2: 統合・精緻化中...")
    raw_json = json.dumps(all_raw_steps, ensure_ascii=False)
    # 長すぎる場合は切り詰め
    if len(raw_json) > 6000:
        raw_json = raw_json[:6000] + "...]"

    prompt2 = f"""以下は{mode_label}動画から抽出した粗いステップリストです。
これを統合・整理して、最終的なステップリストを作成してください。

粗いステップ:
{raw_json}

JSON配列のみ返してください:
[
  {{
    "step_number": 1,
    "text": "具体的な作業指示（指示形で簡潔に）",
    "visual_marker": "カメラで確認できる完了の目印",
    "start_time": "HH:MM:SS",
    "end_time": "HH:MM:SS"
  }}
]

ルール:
- 重複を統合
- 粒度を1〜5分に調整 (細かすぎるものは統合、大きすぎるものは分割)
- 口語を指示形に変換 (「塩入れます」→「塩を加える」)
- 前置き・チャンネル紹介・締めの挨拶は除外
- visual_marker はカメラで視覚的に判定可能な表現
- 5〜10ステップ"""

    response = await llm.generate_text(prompt2)
    match = re.search(r"\[[\s\S]*\]", response)
    if not match:
        return []

    try:
        steps = json.loads(match.group())
    except json.JSONDecodeError:
        # 不完全JSONの場合、最後の有効なオブジェクトまでパース
        raw = match.group()
        # 最後の完全な } を探す
        last_brace = raw.rfind("}")
        if last_brace > 0:
            try:
                steps = json.loads(raw[: last_brace + 1] + "]")
            except json.JSONDecodeError:
                logger.warning("  Stage 2 JSON解析失敗")
                return []
        else:
            return []

    # キー名正規化
    normalized = []
    for i, s in enumerate(steps):
        normalized.append({
            "step_number": s.get("step_number", i + 1),
            "text": s.get("text", ""),
            "visual_marker": s.get("visual_marker", ""),
            "start_time": s.get("start_time", "00:00:00"),
            "end_time": s.get("end_time", ""),
        })
    for i, step in enumerate(normalized):
        if not step["end_time"]:
            step["end_time"] = normalized[i + 1]["start_time"] if i + 1 < len(normalized) else step["start_time"]

    logger.info(f"  Stage 2 完了: {len(normalized)} ステップ")
    return normalized


async def refine_texts(steps: list[dict], llm: OllamaHQClient, mode: str) -> list[dict]:
    """テキストを整理 (Stage 2で大部分対応済みだが、個別にも磨く)."""
    logger.info("  テキスト整理中...")
    mode_label = "DIY作業" if mode == "diy" else "料理"

    steps_json = json.dumps(
        [{"step_number": s["step_number"], "text": s["text"]} for s in steps],
        ensure_ascii=False,
    )

    prompt = f"""以下の{mode_label}ステップのテキストを改善してください。

現在のステップ:
{steps_json}

改善ルール:
- 口語・フィラーを除去（「えーと」「まあ」等）
- 指示形で簡潔に（「〜してください」「〜する」）
- 材料名や数量があれば具体的に含める
- 各ステップは1-2文

JSON配列のみ返して: [{{"step_number": 1, "text": "改善後のテキスト"}}]"""

    try:
        response = await llm.generate_text(prompt)
        match = re.search(r"\[[\s\S]*\]", response)
        if match:
            refined = json.loads(match.group())
            text_map = {r["step_number"]: r["text"] for r in refined}
            for step in steps:
                if step["step_number"] in text_map:
                    step["text"] = text_map[step["step_number"]]
    except Exception:
        logger.debug("  テキスト整理失敗、元のテキストを使用")

    return steps


# ============================================================
# Phase C: 高品質フレーム選択
# ============================================================


def extract_candidate_frames(
    video_path: Path, start_sec: float, end_sec: float,
    output_dir: Path, step_num: int, count: int = CANDIDATE_FRAMES_PER_STEP,
) -> list[Path]:
    """候補フレームを均等間隔で抽出."""
    if end_sec <= start_sec:
        end_sec = start_sec + 60
    interval = (end_sec - start_sec) / (count + 1)

    frames = []
    for i in range(count):
        ts = start_sec + interval * (i + 1)
        output = output_dir / f"step_{step_num:02d}_cand_{i:02d}.jpg"
        try:
            subprocess.run(
                ["ffmpeg", "-ss", str(ts), "-i", str(video_path),
                 "-frames:v", "1", "-q:v", "2", "-y", str(output)],
                check=True, capture_output=True,
            )
            frames.append(output)
        except subprocess.CalledProcessError:
            pass
    return frames


async def select_best_frames(
    candidates: list[Path], step_text: str, llm: OllamaHQClient
) -> dict[str, Path | None]:
    """LLMに候補フレームを見せてベストを選択."""
    if not candidates:
        return {"best": None, "completion": None}

    # 全候補を1枚の画像にはできないので、各候補をスコアリング
    scores = []
    for i, frame_path in enumerate(candidates):
        if not frame_path.exists():
            scores.append((i, -1.0))
            continue
        try:
            image_bytes = frame_path.read_bytes()
            prompt = (
                f"この画像は「{step_text}」というステップの途中の映像です。\n"
                "以下の基準でこの画像のお手本画像としての適切さをスコアリングしてください:\n"
                "- 作業内容が明確に映っているか\n"
                "- ブレや暗さがないか\n"
                "- テロップだけでなく実際の作業が映っているか\n\n"
                "0.0-1.0のスコアのみ回答してください。数字だけ。"
            )
            response = await llm.analyze_image(image_bytes, prompt)
            score_match = re.search(r"(\d+\.?\d*)", response)
            score = float(score_match.group(1)) if score_match else 0.5
            scores.append((i, min(1.0, score)))
        except Exception:
            scores.append((i, 0.3))

    # ベストフレーム (最高スコア)
    scores.sort(key=lambda x: x[1], reverse=True)
    best_idx = scores[0][0] if scores else 0
    # 完了フレーム (後半の候補から最高スコア)
    latter_half = [s for s in scores if s[0] >= len(candidates) // 2]
    comp_idx = latter_half[0][0] if latter_half else best_idx

    best = candidates[best_idx] if best_idx < len(candidates) else None
    completion = candidates[comp_idx] if comp_idx < len(candidates) else None

    # ベストフレームをリネーム
    if best and best.exists():
        best_renamed = best.parent / f"step_{best.name.split('_')[1]}_best.jpg"
        best.rename(best_renamed)
        best = best_renamed
    if completion and completion.exists() and completion != best:
        comp_renamed = completion.parent / f"step_{completion.name.split('_')[1]}_completion.jpg"
        completion.rename(comp_renamed)
        completion = comp_renamed

    return {"best": best, "completion": completion}


# ============================================================
# Phase D: エンリッチメント
# ============================================================


CAPTION_PROMPT = """この画像を詳細に記述してください。以下の観点で具体的に:
1. 場面: 何が映っているか (道具、材料、画面、人物の動作)
2. 状態: 材料や作業対象の現在の状態 (色、形、大きさ、配置)
3. 動作: 行われている/完了した作業
4. 道具: 使用されている道具や機材

ステップの内容: 「{step_text}」
簡潔に3〜5文で回答してください。回答のみ。"""


async def enrich_step(step: dict, best_frame: Path | None, comp_frame: Path | None, llm: OllamaHQClient) -> dict:
    """visual_marker改善 + 詳細キャプション生成."""
    # visual_marker改善
    frame = comp_frame or best_frame
    if frame and frame.exists():
        try:
            image_bytes = frame.read_bytes()
            prompt = (
                f"この画像は「{step['text']}」というステップの完了時点です。\n"
                "カメラで視覚的に判定可能な完了基準を1文で。回答のみ。"
            )
            improved = await llm.analyze_image(image_bytes, prompt)
            step["visual_marker"] = improved.strip().strip('"').strip("「」")
        except Exception:
            pass

    # 詳細キャプション
    frame = best_frame or comp_frame
    if frame and frame.exists():
        try:
            image_bytes = frame.read_bytes()
            caption = await llm.analyze_image(image_bytes, CAPTION_PROMPT.format(step_text=step["text"]))
            step["frame_caption"] = caption.strip()
        except Exception:
            step["frame_caption"] = step["text"]
    else:
        step["frame_caption"] = step["text"]

    return step


async def score_quality(steps: list[dict], llm: OllamaHQClient) -> list[dict]:
    """品質スコアリング."""
    steps_json = json.dumps(
        [{"step_number": s["step_number"], "text": s["text"], "visual_marker": s.get("visual_marker", "")}
         for s in steps], ensure_ascii=False,
    )

    prompt = f"""以下のステップリストの品質を評価してください。0.0〜1.0 のスコアを付けてください。

評価基準: 具体性、視覚判定可能性、粒度の適切さ

ステップ:
{steps_json}

JSON配列のみで回答: [{{"step_number": 1, "score": 0.8}}]"""

    try:
        response = await llm.generate_text(prompt)
        match = re.search(r"\[[\s\S]*\]", response)
        if match:
            scores = json.loads(match.group())
            score_map = {s["step_number"]: float(s.get("score", 0.5)) for s in scores}
            for step in steps:
                step["quality_score"] = score_map.get(step["step_number"], 0.5)
    except Exception:
        for step in steps:
            step["quality_score"] = 0.5

    before = len(steps)
    steps = [s for s in steps if s.get("quality_score", 0) >= QUALITY_THRESHOLD]
    dropped = before - len(steps)
    if dropped:
        logger.info(f"  品質ゲート: {dropped} ステップを除外")
    return steps


# ============================================================
# Phase E: 格納
# ============================================================


async def embed_and_store(steps: list[dict], video_id: str, mode: str):
    total_steps = len(steps)
    embedding_client = EmbeddingClient()

    texts = [s["text"] for s in steps]
    captions = [s.get("frame_caption", s["text"]) for s in steps]
    embeddings = await embedding_client.embed_documents(texts)
    caption_embeddings = await embedding_client.embed_documents(captions)

    step_data = []
    for i, step in enumerate(steps):
        step_data.append({
            "step_number": step["step_number"],
            "total_steps": total_steps,
            "text": step["text"],
            "frame_path": step.get("best_frame_url", ""),
            "visual_marker": step.get("visual_marker", ""),
            "frame_start_path": "",
            "frame_mid_path": step.get("best_frame_url", ""),
            "frame_end_path": step.get("completion_frame_url", ""),
            "quality_score": step.get("quality_score", 0.5),
            "duration_sec": step.get("duration_sec", 0.0),
            "frame_caption": step.get("frame_caption", ""),
            "caption_embedding": caption_embeddings[i],
        })

    milvus = MilvusRAGClient()
    count = milvus.insert_steps(collection=mode, video_id=video_id, steps=step_data, embeddings=embeddings)
    logger.info(f"  {count} ステップを {mode} に格納")

    # BM25
    from src.domain.guide.model import RagResult
    rag_results = [
        RagResult(video_id=video_id, step_number=s["step_number"], total_steps=total_steps,
                  text=s["text"], frame_url=s["frame_path"], visual_marker=s.get("visual_marker", ""),
                  quality_score=s.get("quality_score", 0.5))
        for s in step_data
    ]
    bm25 = BM25Index()
    bm25.build(rag_results)

    # テスト検索
    test_emb = await embedding_client.embed_query(texts[0])
    results = milvus.search(collection=mode, query_embedding=test_emb, top_k=3)
    for r in results:
        logger.info(f"  検索: Step {r.step_number} (q={r.quality_score:.2f}): {r.text[:40]}")

    return count


# ============================================================
# メインパイプライン (1動画)
# ============================================================


async def ingest_one(url: str, mode: str, llm: OllamaHQClient) -> int:
    """1本の動画をインジェスト。戻り値はステップ数。"""
    video_id = extract_video_id(url)
    logger.info(f"=== Ingest: {video_id} (mode={mode}) ===")

    if is_already_ingested(video_id, mode):
        logger.info(f"  スキップ: 既にインジェスト済み")
        return 0

    static_dir = Path(settings.static_dir)
    video_dir = static_dir / "videos" / video_id
    frames_dir = video_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    # ダウンロード先: 永続保存 (static/videos/{video_id}/)
    dl_dir = video_dir / "source"
    dl_dir.mkdir(parents=True, exist_ok=True)

    # Step 1-2: ダウンロード (永続保存)
    logger.info("[1/12] 字幕ダウンロード...")
    vtt_path = download_subtitles(url, dl_dir)
    if not vtt_path:
        logger.warning("  字幕なし、スキップ")
        return 0

    logger.info("[2/12] 動画ダウンロード...")
    # 既にダウンロード済みならスキップ
    existing_mp4 = list(dl_dir.glob("*.mp4"))
    if existing_mp4:
        video_path = existing_mp4[0]
        logger.info(f"  既存動画を使用: {video_path.name}")
    else:
        video_path = download_video(url, dl_dir)
        if not video_path:
            logger.warning("  動画DL失敗、スキップ")
            return 0

    # Step 3: 字幕パース + チャンク分割
    logger.info("[3/12] 字幕パース + チャンク分割...")
    segments = parse_vtt(vtt_path)
    subtitle_chunks = chunk_subtitles(segments)
    logger.info(f"  {len(segments)} セグメント → {len(subtitle_chunks)} チャンク")

    # Step 4: 2段階ステップ分解
    logger.info("[4/12] 2段階ステップ分解...")
    steps = await two_stage_segmentation(subtitle_chunks, llm, mode)
    if not steps:
        logger.warning("  ステップ分解失敗")
        return 0

    # duration計算
    for step in steps:
        start = ts_to_sec(step.get("start_time", "00:00:00"))
        end = ts_to_sec(step.get("end_time", "00:00:00"))
        step["duration_sec"] = max(0, end - start)

    # Step 5: テキスト整理
    logger.info("[5/12] テキスト整理...")
    steps = await refine_texts(steps, llm, mode)

    # Step 6: 候補フレーム抽出
    logger.info("[6/12] 候補フレーム抽出...")
    all_candidates = []
    for step in steps:
        start = ts_to_sec(step.get("start_time", "00:00:00"))
        end = ts_to_sec(step.get("end_time", "00:00:00"))
        if end <= start:
            end = start + 60
        logger.info(f"  Step {step['step_number']}: {start:.0f}s-{end:.0f}s ({end-start:.0f}s)")
        candidates = extract_candidate_frames(video_path, start, end, frames_dir, step["step_number"])
        all_candidates.append(candidates)
    total_frames = sum(len(c) for c in all_candidates)
    logger.info(f"  {total_frames} 候補フレームを抽出")

    # Step 7: LLMベストフレーム選択
    logger.info("[7/12] LLMでベストフレーム選択...")
    for i, (step, candidates) in enumerate(zip(steps, all_candidates)):
        selected = await select_best_frames(candidates, step["text"], llm)
        best = selected.get("best")
        comp = selected.get("completion")
        step["best_frame_url"] = f"/static/videos/{video_id}/frames/{best.name}" if best else ""
        step["completion_frame_url"] = f"/static/videos/{video_id}/frames/{comp.name}" if comp else ""
        logger.info(f"  Step {step['step_number']}: best={best.name if best else 'none'}")

        # 不採用の候補フレームを削除
        for c in candidates:
            if c.exists() and c != best and c != comp:
                c.unlink()

    # Step 8-9: エンリッチメント
    logger.info("[8/12] visual_marker改善 + [9/12] キャプション生成...")
    for step in steps:
        best_path = frames_dir / Path(step.get("best_frame_url", "")).name if step.get("best_frame_url") else None
        comp_path = frames_dir / Path(step.get("completion_frame_url", "")).name if step.get("completion_frame_url") else None
        step = await enrich_step(step, best_path, comp_path, llm)
        logger.info(f"  Step {step['step_number']}: {step['text'][:30]}  marker={step.get('visual_marker', '')[:25]}")

    # Step 10: 品質スコアリング
    logger.info("[10/12] 品質スコアリング...")
    steps = await score_quality(steps, llm)
    if not steps:
        logger.warning("  全ステップが品質ゲートで除外")
        return 0

    # ステップ番号振り直し
    for i, step in enumerate(steps):
        step["step_number"] = i + 1

    # Step 11-12: 格納
    logger.info("[11/12] 埋め込み + 格納...")
    count = await embed_and_store(steps, video_id, mode)
    logger.info(f"[12/12] 完了! {count} steps indexed")

    return count


# ============================================================
# CLI
# ============================================================


async def cmd_search(args):
    llm = OllamaHQClient()
    videos = search_youtube(args.topic, args.count, args.mode)
    if not videos:
        logger.warning("検索結果が0件です")
        return

    total = 0
    for v in videos:
        try:
            n = await ingest_one(v["url"], v["mode"], llm)
            total += n
        except Exception as e:
            logger.error(f"  失敗: {v['url']}: {e}")
    logger.info(f"=== 全完了: {total} steps from {len(videos)} videos ===")


async def cmd_batch(args):
    data = json.loads(Path(args.file).read_text(encoding="utf-8"))
    sources = data.get("sources", [])
    llm = OllamaHQClient()

    total = 0
    for src in sources:
        try:
            n = await ingest_one(src["url"], src.get("mode", "diy"), llm)
            total += n
        except Exception as e:
            logger.error(f"  失敗: {src['url']}: {e}")
    logger.info(f"=== 全完了: {total} steps from {len(sources)} videos ===")


async def cmd_url(args):
    llm = OllamaHQClient()
    await ingest_one(args.url, args.mode, llm)


async def main():
    parser = argparse.ArgumentParser(description="高品質RAGデータ作成パイプライン")
    sub = parser.add_subparsers(dest="command", required=True)

    # search
    p_search = sub.add_parser("search", help="YouTube自動検索 → インジェスト")
    p_search.add_argument("topic", help="検索トピック")
    p_search.add_argument("--mode", default="diy", choices=["diy", "cooking"])
    p_search.add_argument("--count", type=int, default=3, help="インジェスト本数")

    # batch
    p_batch = sub.add_parser("batch", help="JSONファイルからバッチインジェスト")
    p_batch.add_argument("file", help="sources.jsonのパス")

    # url
    p_url = sub.add_parser("url", help="単一URLインジェスト")
    p_url.add_argument("url", help="YouTube URL")
    p_url.add_argument("--mode", default="diy", choices=["diy", "cooking"])

    args = parser.parse_args()

    if args.command == "search":
        await cmd_search(args)
    elif args.command == "batch":
        await cmd_batch(args)
    elif args.command == "url":
        await cmd_url(args)


if __name__ == "__main__":
    asyncio.run(main())
