"""LangChain Tool 定義.

共通ツール (コンテキスト不要): timer, alert, text
コンテキストアウェアツール (セッション依存): step_image, step_video
HQ追加ツール: search_rag, modify_step
"""

from langchain_core.tools import tool

from src.application.guide.blocks import AlertBlock, ImageBlock, TextBlock, TimerBlock, VideoBlock


# === 共通ツール (コンテキスト不要) ===


@tool
def set_timer(duration_sec: int, label: str) -> dict:
    """タイマーをセットする。煮込み時間や待ち時間に使う。"""
    return TimerBlock(duration_sec=duration_sec, label=label).model_dump()


@tool
def send_alert(message: str, severity: str = "info") -> dict:
    """ユーザーに警告や通知を表示する。severity: info, warning, danger"""
    return AlertBlock(message=message, severity=severity).model_dump()  # type: ignore[arg-type]


@tool
def show_text(content: str, style: str = "normal") -> dict:
    """テキストを表示する。style: normal, emphasis, warning"""
    return TextBlock(content=content, style=style).model_dump()  # type: ignore[arg-type]


BASIC_TOOLS = [set_timer, send_alert, show_text]


# === コンテキストアウェアツール (plan_steps + source_id 必要) ===


def build_context_tools(
    plan_steps_ref: list | None = None,
    plan_source_id: str = "",
) -> list:
    """セッションのプラン情報を使うツールを生成。"""

    def _resolve_frame_url(step_number: int) -> str | None:
        if not plan_steps_ref:
            return None
        for s in plan_steps_ref:
            sn = s.step_number if hasattr(s, "step_number") else s.get("step_number")
            fp = s.frame_path if hasattr(s, "frame_path") else s.get("frame_path", "")
            if sn == step_number and fp:
                return f"/static/videos/{plan_source_id}/frames/{fp}" if plan_source_id else ""
        return None

    def _resolve_video_url() -> str | None:
        """プランのソース動画 URL (YouTube)."""
        if not plan_source_id:
            return None
        # source_id が YouTube video_id の場合
        if len(plan_source_id) == 11 or plan_source_id.startswith("generated-"):
            # generated プランは動画なし
            if plan_source_id.startswith("generated-"):
                return None
            return f"https://www.youtube.com/watch?v={plan_source_id}"
        return None

    @tool
    def show_step_image(step_number: int = 0, caption: str = "") -> dict:
        """指定ステップの参考画像を表示する。step_number=0 で現在のステップ。"""
        if step_number == 0 and plan_steps_ref:
            # 現在のステップは呼び出し元で解決
            step_number = 1
        url = _resolve_frame_url(step_number)
        if not url:
            return TextBlock(content=f"ステップ{step_number}の参考画像が見つかりません", style="normal").model_dump()
        return ImageBlock(url=url, caption=caption or f"ステップ{step_number}の参考画像").model_dump()

    @tool
    def show_video() -> dict:
        """このプランの参考動画を表示する。"""
        url = _resolve_video_url()
        if not url:
            return TextBlock(content="参考動画が見つかりません", style="normal").model_dump()
        return VideoBlock(url=url).model_dump()

    return [show_step_image, show_video]


def build_common_tools(
    plan_steps_ref: list | None = None,
    plan_source_id: str = "",
) -> list:
    """Stage 1 用ツール (共通 + コンテキストアウェア)."""
    return BASIC_TOOLS + build_context_tools(plan_steps_ref, plan_source_id)


# === HQ追加ツール (RAG/プラン操作) ===


def build_hq_tools(
    rag_client=None,
    embedding_client=None,
    plan_steps_ref: list | None = None,
    plan_source_id: str = "",
) -> list:
    """HQ用ツール = 共通 + コンテキスト + RAG + プラン操作."""

    @tool
    def search_rag(query: str, top_k: int = 3) -> str:
        """RAGデータベースから関連情報を検索する。レシピや手順の参考情報が必要な時に使う。"""
        if not rag_client or not embedding_client:
            return "RAGが利用できません"
        import asyncio
        try:
            loop = asyncio.get_event_loop()
            embedding = loop.run_until_complete(embedding_client.embed_query(query))
            results = []
            for collection in ["diy", "cooking"]:
                hits = rag_client.search(collection=collection, query_embedding=embedding, top_k=top_k)
                results.extend(hits)
            if not results:
                return "関連する手順が見つかりませんでした"
            return "\n".join(
                f"- Step {r.step_number}: {r.text}" + (f" [完了基準: {r.visual_marker}]" if r.visual_marker else "")
                for r in results[:top_k]
            )
        except Exception as e:
            return f"RAG検索エラー: {e}"

    @tool
    def modify_step(step_index: int, new_text: str) -> str:
        """プランのステップを修正する。材料代替や手順変更に使う。step_indexは0始まり。"""
        if plan_steps_ref is None:
            return "プランが利用できません"
        if step_index < 0 or step_index >= len(plan_steps_ref):
            return f"ステップ{step_index}は存在しません (全{len(plan_steps_ref)}ステップ)"
        old_text = plan_steps_ref[step_index].text
        plan_steps_ref[step_index].text = new_text
        return f"Step {step_index + 1} を修正しました: 「{old_text}」→「{new_text}」"

    return build_common_tools(plan_steps_ref, plan_source_id) + [search_rag, modify_step]


# 後方互換
COMMON_TOOLS = BASIC_TOOLS
