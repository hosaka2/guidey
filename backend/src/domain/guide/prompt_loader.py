"""プロンプト一元管理 (バージョン付き).

prompts/{name}/{version}.md を読み込み、変数を展開してプロンプト文字列を生成する。

バージョン変更は PROMPT_VERSIONS を書き換えるだけ。
v2 を試すなら v2.md を置いて定数を変えれば、全呼び出しが切り替わる。
"""

import functools
from pathlib import Path

_PROMPTS_DIR = Path(__file__).parent / "prompts"


# === バージョン定義 ===

PROMPT_VERSIONS: dict[str, str] = {
    "periodic_stage1": "v1",
    "user_action_stage1": "v1",
    "stage2_escalation": "v1",
    "plan_generation": "v1",
    "calibration": "v1",
    "appraise_caption": "v1",
    "analyze_oneshot": "v1",
    "explore_stage1": "v1",
}


class Prompt:
    """プロンプト名定数。IDE補完 + typo防止。"""

    PERIODIC_STAGE1: str = "periodic_stage1"
    USER_ACTION_STAGE1: str = "user_action_stage1"
    STAGE2_ESCALATION: str = "stage2_escalation"
    PLAN_GENERATION: str = "plan_generation"
    CALIBRATION: str = "calibration"
    APPRAISE_CAPTION: str = "appraise_caption"
    ANALYZE_ONESHOT: str = "analyze_oneshot"
    EXPLORE_STAGE1: str = "explore_stage1"




@functools.lru_cache(maxsize=32)
def _load_template(name: str, version: str) -> str:
    """mdファイルを読み込み (起動後キャッシュ)."""
    path = _PROMPTS_DIR / name / f"{version}.md"
    if not path.exists():
        raise FileNotFoundError(f"Prompt not found: {path}")
    return path.read_text(encoding="utf-8").strip()


def render(name: str, **kwargs: str) -> str:
    """テンプレートに変数を展開.

    PROMPT_VERSIONS で定義されたバージョンの md を読み込む。
    未使用プレースホルダーは空文字に置換 (セクションが空の場合)。
    """
    version = PROMPT_VERSIONS[name]
    template = _load_template(name, version)
    result = template
    for key, value in kwargs.items():
        result = result.replace(f"{{{key}}}", value)
    return result


# === セクション構築ヘルパー ===
def build_step_section(step_number: int, text: str, visual_marker: str = "") -> str:
    """現在のステップ情報セクション."""
    lines = [f"\n## 現在のステップ (Step {step_number})", f"内容: {text}"]
    if visual_marker:
        lines.append(f"完了の目印: {visual_marker}")
    return "\n".join(lines)


def build_next_step_line(step_number: int, text: str) -> str:
    return f"次のステップ (Step {step_number}): {text}"


def build_observations_section(observations: list[str] | None) -> str:
    if not observations:
        return ""
    lines = ["\n## 直近の観察結果"]
    for obs in observations[-3:]:
        lines.append(f"- {obs}")
    return "\n".join(lines)


def build_progress_section(current_step_index: int, total_steps: int) -> str:
    """進捗情報セクション."""
    if total_steps <= 0:
        return ""
    step_num = current_step_index + 1
    pct = round(step_num / total_steps * 100)
    return f"\n## 進捗: {step_num}/{total_steps} ステップ目 ({pct}%)"


def build_chat_history_section(history: list[dict]) -> str:
    """会話履歴セクション (直近5ターンまで)."""
    if not history:
        return ""
    lines = ["\n## これまでの会話"]
    for msg in history[-10:]:  # 最大10メッセージ (5ターン)
        role = "ユーザー" if msg.get("role") == "user" else "アシスタント"
        content = str(msg.get("content", ""))[:100]
        lines.append(f"- {role}: {content}")
    return "\n".join(lines)


def build_multi_source_section(multi_source_context: str) -> str:
    return (
        "\n## 参考ソース（複数の情報源から収集）\n"
        "以下は複数のソースから集めた手順です。\n"
        "**各ソースの良い部分を組み合わせて、最適なプランを作成してください。**\n"
        "- 明確な判定基準があるソースからは visual_marker を採用\n"
        "- 丁寧な下処理があるソースからはその手順を採用\n"
        "- 時短テクがあるソースからは効率的な方法を採用\n"
        f"\n{multi_source_context}"
    )


def build_rag_section(rag_results: list) -> str:
    if not rag_results:
        return ""
    lines = ["\n## 参考情報（既存の手順データ）"]
    for r in rag_results[:5]:
        lines.append(f"- ステップ{r.step_number}: {r.text}")
    return "\n".join(lines)
