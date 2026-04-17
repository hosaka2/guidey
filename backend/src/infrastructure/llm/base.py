import base64
from collections.abc import AsyncIterator
from typing import Protocol, TypeVar

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import BaseTool
from langgraph.prebuilt import create_react_agent
from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class LLMClient(Protocol):
    async def analyze_image(self, image_bytes: bytes, system_prompt: str) -> str: ...

    async def analyze_image_stream(
        self, image_bytes: bytes, system_prompt: str
    ) -> AsyncIterator[str]: ...

    async def generate_text(self, system_prompt: str) -> str: ...

    async def call_structured(
        self, system_prompt: str, schema: type[T],
        image_bytes: bytes | None = None,
    ) -> T:
        """Structured Output で呼び出し。Pydantic インスタンスを返す。"""
        ...

    async def call_react_agent(
        self, system_prompt: str, tools: list[BaseTool],
        response_schema: type[T],
        image_bytes: bytes | None = None,
    ) -> tuple[T, list[dict]]:
        """LangGraph create_react_agent でツールループ。戻り値: (構造化応答, tool アーティファクト)."""
        ...


class BaseLangChainClient:
    """LangChain BaseChatModel を使う LLMClient の共通実装.

    サブクラスで `_supports_prompt_caching = True` にすると、
    system_prompt 部分に `cache_control: {"type":"ephemeral"}` を付与して
    プロバイダー側のプロンプトキャッシュ (Anthropic Claude 等) を有効化する。
    """

    _model: BaseChatModel
    _supports_prompt_caching: bool = False  # サブクラスで上書き

    def _build_message(self, image_bytes: bytes | None, system_prompt: str) -> HumanMessage:
        text_block: dict = {"type": "text", "text": system_prompt}
        if self._supports_prompt_caching:
            # Anthropic: 同一の長い prompt を繰り返すときトークン量を 10x 削減
            text_block["cache_control"] = {"type": "ephemeral"}

        # 画像なしで cache_control も不要なら素の文字列で軽量に
        if not image_bytes and not self._supports_prompt_caching:
            return HumanMessage(content=system_prompt)

        content: list[dict] = [text_block]
        if image_bytes:
            image_b64 = base64.b64encode(image_bytes).decode("utf-8")
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                }
            )
        return HumanMessage(content=content)

    async def analyze_image(self, image_bytes: bytes, system_prompt: str) -> str:
        message = self._build_message(image_bytes, system_prompt)
        response = await self._model.ainvoke([message])
        return str(response.content)

    async def analyze_image_stream(
        self, image_bytes: bytes, system_prompt: str
    ) -> AsyncIterator[str]:
        message = self._build_message(image_bytes, system_prompt)
        async for chunk in self._model.astream([message]):
            if chunk.content:
                yield str(chunk.content)

    async def generate_text(self, system_prompt: str) -> str:
        # 画像なしパスも _build_message 経由にして prompt caching を一貫適用
        message = self._build_message(None, system_prompt)
        response = await self._model.ainvoke([message])
        return str(response.content)

    async def call_structured(
        self, system_prompt: str, schema: type[T],
        image_bytes: bytes | None = None,
    ) -> T:
        structured = self._model.with_structured_output(schema)
        message = self._build_message(image_bytes, system_prompt)
        result = await structured.ainvoke([message])
        return result  # type: ignore[return-value]

    async def call_react_agent(
        self, system_prompt: str, tools: list[BaseTool],
        response_schema: type[T],
        image_bytes: bytes | None = None,
    ) -> tuple[T, list[dict]]:
        agent = create_react_agent(
            self._model,
            tools=tools,
            response_format=response_schema,
        )
        message = self._build_message(image_bytes, system_prompt)
        result = await agent.ainvoke({"messages": [message]})

        # ToolMessage.artifact から block を収集
        artifacts: list[dict] = []
        for m in result.get("messages", []):
            if isinstance(m, ToolMessage):
                art = getattr(m, "artifact", None)
                if isinstance(art, dict) and "type" in art:
                    artifacts.append(art)

        structured: T = result["structured_response"]
        return structured, artifacts
