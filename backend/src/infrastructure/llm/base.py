import base64
from collections.abc import AsyncIterator
from typing import Protocol

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import BaseTool


class LLMClient(Protocol):
    async def analyze_image(self, image_bytes: bytes, system_prompt: str) -> str: ...

    async def analyze_image_stream(
        self, image_bytes: bytes, system_prompt: str
    ) -> AsyncIterator[str]: ...

    async def generate_text(self, system_prompt: str) -> str: ...

    async def call_with_tools(
        self, system_prompt: str, tools: list[BaseTool],
        image_bytes: bytes | None = None, max_rounds: int = 5,
    ) -> tuple[str, list[dict]]:
        """ツール付きで呼び出し。戻り値: (最終テキスト, 実行されたツール結果リスト)."""
        ...


class BaseLangChainClient:
    """LangChain BaseChatModel を使う LLMClient の共通実装."""

    _model: BaseChatModel

    def _build_message(self, image_bytes: bytes, system_prompt: str) -> HumanMessage:
        content: list[dict] = [{"type": "text", "text": system_prompt}]
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
        message = HumanMessage(content=system_prompt)
        response = await self._model.ainvoke([message])
        return str(response.content)

    async def call_with_tools(
        self, system_prompt: str, tools: list[BaseTool],
        image_bytes: bytes | None = None, max_rounds: int = 5,
    ) -> tuple[str, list[dict]]:
        """ツール付き呼び出し。LLMがツール呼び出しを要求→実行→結果を返すループ。"""
        model_with_tools = self._model.bind_tools(tools)
        tool_map = {t.name: t for t in tools}

        # 初期メッセージ
        if image_bytes:
            messages = [self._build_message(image_bytes, system_prompt)]
        else:
            messages = [HumanMessage(content=system_prompt)]

        tool_results: list[dict] = []

        for _ in range(max_rounds):
            response = await model_with_tools.ainvoke(messages)
            messages.append(response)

            # ツール呼び出しがなければ終了
            if not response.tool_calls:
                return str(response.content), tool_results

            # ツール実行
            for tc in response.tool_calls:
                tool_name = tc["name"]
                tool_args = tc["args"]
                fn = tool_map.get(tool_name)
                if fn:
                    result = fn.invoke(tool_args)
                    tool_results.append(result)
                    messages.append(
                        ToolMessage(content=str(result), tool_call_id=tc["id"])
                    )

        # max_rounds 到達
        final = messages[-1]
        return str(getattr(final, "content", "")), tool_results
