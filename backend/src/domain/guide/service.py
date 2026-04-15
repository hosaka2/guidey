from src.common.exceptions import UnsupportedModeError
from src.domain.guide.model import (
    MODE_CONFIGS,
    GuideMode,
    ModeConfig,
    PlanStep,
    RagResult,
)

# re-export for convenience
__all__ = ["GuideService"]


class GuideService:
    def get_mode_config(self, mode: GuideMode) -> ModeConfig:
        config = MODE_CONFIGS.get(mode)
        if not config:
            raise UnsupportedModeError(mode)
        return config

    def build_system_prompt(
        self,
        config: ModeConfig,
        trigger_word: str,
        goal: str = "",
        rag_results: list[RagResult] | None = None,
    ) -> str:
        parts = [config.prompt]
        if goal:
            parts.append(f"ユーザーの目的: 「{goal}」")
        if rag_results:
            steps_text = "\n".join(
                f"  ステップ {r.step_number}/{r.total_steps}: {r.text}"
                for r in rag_results
            )
            parts.append(f"参考手順:\n{steps_text}")
        parts.append(
            f"ユーザーは今「{trigger_word}」と言いました。"
            "画像を見て現在の状況を判断し、目的に向けた次の1ステップを具体的に指示してください。"
        )
        return " ".join(parts)

    def build_judgment_prompt(
        self,
        current_step: PlanStep,
        next_step: PlanStep | None,
        recent_observations: list[str] | None = None,
    ) -> str:
        """自律モード: 3択判定プロンプト (状態固定方式)."""
        lines = [
            "あなたは作業監視アシスタントです。",
            "カメラ画像を見て、現在のステップの進捗を判定してください。",
            "",
            f"## 現在のステップ (Step {current_step.step_number})",
            f"内容: {current_step.text}",
        ]
        if current_step.visual_marker:
            lines.append(f"完了の目印: {current_step.visual_marker}")

        if next_step:
            lines.append(f"\n## 次のステップ (Step {next_step.step_number})")
            lines.append(f"内容: {next_step.text}")

        if recent_observations:
            lines.append("\n## 直近の観察結果")
            for obs in recent_observations[-3:]:
                lines.append(f"- {obs}")

        lines.extend([
            "",
            "## 判定",
            "画像を見て、以下の3択から1つ選んでください:",
            "- continue: 現在のステップを継続中",
            "- next: 現在のステップが完了し、次に進んだ",
            "- anomaly: 想定外の状態（困っている、手が止まっている等）",
            "",
            "必ず以下のJSON形式のみで回答してください。他のテキストは含めないこと:",
            '{"judgment": "continue又はnext又はanomaly", "confidence": 0.0から1.0, "message": "状況の簡潔な説明"}',
        ])

        return "\n".join(lines)

    def build_plan_generation_prompt(
        self,
        goal: str,
        mode: GuideMode,
        rag_results: list[RagResult] | None = None,
        multi_source_context: str = "",
    ) -> str:
        """ゴールからステップリストを生成するプロンプト (Multi-Document Synthesis対応)."""
        mode_label = MODE_CONFIGS[mode].label

        lines = [
            f"あなたは{mode_label}の専門家です。",
            f"ユーザーの目的「{goal}」を達成するためのステップリストを作成してください。",
        ]

        # 複数ソースがある場合: Multi-Document Synthesis
        if multi_source_context:
            lines.extend([
                "",
                "## 参考ソース（複数の情報源から収集）",
                "以下は複数のソースから集めた手順です。",
                "**各ソースの良い部分を組み合わせて、最適なプランを作成してください。**",
                "- 明確な判定基準があるソースからは visual_marker を採用",
                "- 丁寧な下処理があるソースからはその手順を採用",
                "- 時短テクがあるソースからは効率的な方法を採用",
                "",
                multi_source_context,
            ])
        elif rag_results:
            lines.append("\n## 参考情報（既存の手順データ）")
            for r in rag_results[:5]:
                lines.append(f"- ステップ{r.step_number}: {r.text}")

        lines.extend([
            "",
            "## 制約",
            "- 5〜10ステップに分解",
            "- 各ステップは1〜5分で完了する粒度",
            "- 各ステップにはカメラで視覚的に判定可能な完了基準 (visual_marker) を付ける",
            "- 抽象的な表現はNG（例: 「美味しく作る」）、具体的な動作で記述",
            "- 複数ソースがある場合は、各ソースの最良の部分を組み合わせる",
            "",
            "## 出力形式",
            "必ず以下のJSON配列のみで回答してください。他のテキストは含めないこと:",
            '[',
            '  {"step_number": 1, "text": "具体的な作業指示", "visual_marker": "カメラで確認できる完了の目印"},',
            '  {"step_number": 2, "text": "...", "visual_marker": "..."},',
            '  ...',
            ']',
        ])

        return "\n".join(lines)
