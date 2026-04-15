"""LangChain Tool 定義.

共通ツール: timer, alert, text, image
HQ追加ツール: search_rag, modify_step
"""

from langchain_core.tools import tool

from src.application.guide.blocks import AlertBlock, ImageBlock, TextBlock, TimerBlock


# === 共通ツール ===


@tool
def set_timer(duration_sec: int, label: str) -> dict:
    """タイマーをセットする。煮込み時間や待ち時間に使う。"""
    return TimerBlock(duration_sec=duration_sec, label=label).model_dump()


@tool
def send_alert(message: str, severity: str = "info") -> dict:
    """ユーザーに警告や通知を表示する。severity: info, warning, danger"""
    return AlertBlock(message=message, severity=severity).model_dump()  # type: ignore[arg-type]


@tool
def show_image(url: str, caption: str = "") -> dict:
    """参考画像を表示する。"""
    return ImageBlock(url=url, caption=caption or None).model_dump()


@tool
def show_text(content: str, style: str = "normal") -> dict:
    """テキストを表示する。style: normal, emphasis, warning"""
    return TextBlock(content=content, style=style).model_dump()  # type: ignore[arg-type]


COMMON_TOOLS = [set_timer, send_alert, show_text, show_image]


# === HQ追加ツール (RAG/プラン操作) ===
# ランタイム依存があるため、ファクトリで生成する


def build_hq_tools(
    rag_client=None,
    embedding_client=None,
    plan_steps_ref: list | None = None,
) -> list:
    """HQ用ツールを生成。RAGクライアント等をクロージャでキャプチャ。"""

    @tool
    def search_rag(query: str, top_k: int = 3) -> str:
        """RAGデータベースから関連情報を検索する。レシピや手順の参考情報が必要な時に使う。"""
        if not rag_client or not embedding_client:
            return "RAGが利用できません"
        import asyncio
        try:
            loop = asyncio.get_event_loop()
            embedding = loop.run_until_complete(embedding_client.embed_query(query))
            # diy と cooking 両方検索
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

    return COMMON_TOOLS + [search_rag, modify_step]


# 後方互換
GEMMA_TOOLS = COMMON_TOOLS
HQ_TOOLS = COMMON_TOOLS  # build_hq_tools() で動的に拡張
