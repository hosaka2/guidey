"""LangChain Tool 定義.

ブロック生成系ツールは `response_format="content_and_artifact"` を使い、
LLM には人間可読な content、後続処理には artifact (dict) を渡す。

  Stage 1: (ツール未使用、Structured Output のみ)
  Stage 2: BASIC_TOOLS + context tools + RAG/プラン操作 を create_react_agent で実行
"""

from langchain_core.tools import tool

from src.application.guide.schemas.blocks import AlertBlock, ImageBlock, TextBlock, TimerBlock, VideoBlock

# === 共通ツール (コンテキスト不要) ===


@tool(response_format="content_and_artifact")
def set_timer(duration_sec: int, label: str) -> tuple[str, dict]:
    """タイマーをセットする。煮込み時間や待ち時間に使う。"""
    block = TimerBlock(duration_sec=duration_sec, label=label).model_dump()
    return f"{label} のタイマーを {duration_sec} 秒でセットしました", block


@tool(response_format="content_and_artifact")
def send_alert(message: str, severity: str = "info") -> tuple[str, dict]:
    """ユーザーに警告や通知を表示する。severity: info, warning, danger"""
    block = AlertBlock(message=message, severity=severity).model_dump()  # type: ignore[arg-type]
    return f"[{severity}] {message}", block


@tool(response_format="content_and_artifact")
def show_text(content: str, style: str = "normal") -> tuple[str, dict]:
    """テキストを表示する。style: normal, emphasis, warning"""
    block = TextBlock(content=content, style=style).model_dump()  # type: ignore[arg-type]
    return content, block


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
        if not plan_source_id:
            return None
        if len(plan_source_id) == 11 or plan_source_id.startswith("generated-"):
            if plan_source_id.startswith("generated-"):
                return None
            return f"https://www.youtube.com/watch?v={plan_source_id}"
        return None

    @tool(response_format="content_and_artifact")
    def show_step_image(step_number: int = 0, caption: str = "") -> tuple[str, dict]:
        """指定ステップの参考画像を表示する。step_number=0 で現在のステップ。"""
        sn = step_number if step_number > 0 else 1
        url = _resolve_frame_url(sn)
        if not url:
            block = TextBlock(content=f"ステップ{sn}の参考画像が見つかりません").model_dump()
            return block["content"], block
        block = ImageBlock(url=url, caption=caption or f"ステップ{sn}の参考画像").model_dump()
        return f"ステップ{sn}の参考画像を表示", block

    @tool(response_format="content_and_artifact")
    def show_video() -> tuple[str, dict]:
        """このプランの参考動画を表示する。"""
        url = _resolve_video_url()
        if not url:
            block = TextBlock(content="参考動画が見つかりません").model_dump()
            return block["content"], block
        block = VideoBlock(url=url).model_dump()
        return "参考動画を表示", block

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
    async def search_rag(query: str, top_k: int = 3) -> str:
        """RAGデータベースから関連情報を検索する。レシピや手順の参考情報が必要な時に使う。"""
        if not rag_client or not embedding_client:
            return "RAGが利用できません"
        try:
            embedding = await embedding_client.embed_query(query)
            results = []
            for collection in ["diy", "cooking"]:
                hits = rag_client.search(
                    collection=collection,
                    query_embedding=embedding,
                    top_k=top_k,
                )
                results.extend(hits)
            if not results:
                return "関連する手順が見つかりませんでした"
            return "\n".join(
                f"- Step {r.step_number}: {r.text}"
                + (f" [完了基準: {r.visual_marker}]" if r.visual_marker else "")
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
