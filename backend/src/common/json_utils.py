"""LLM出力からJSON抽出するユーティリティ."""

import json
import logging
import re

logger = logging.getLogger(__name__)


def extract_json_object(raw: str) -> dict | None:
    """LLM出力からJSON objectを抽出。失敗時は None。"""
    # そのままパース
    try:
        data = json.loads(raw.strip())
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, ValueError):
        pass

    # regex で {} を抽出
    match = re.search(r"\{[\s\S]*\}", raw)
    if match:
        try:
            data = json.loads(match.group())
            if isinstance(data, dict):
                return data
        except (json.JSONDecodeError, ValueError):
            pass

    return None


def extract_json_array(raw: str) -> list | None:
    """LLM出力からJSON arrayを抽出。不完全JSONも部分的に回復。"""
    # そのままパース
    try:
        data = json.loads(raw.strip())
        if isinstance(data, list):
            return data
    except (json.JSONDecodeError, ValueError):
        pass

    # regex で [] を抽出
    match = re.search(r"\[[\s\S]*\]", raw)
    if match:
        try:
            data = json.loads(match.group())
            if isinstance(data, list):
                return data
        except json.JSONDecodeError:
            # 不完全JSON: 最後の有効な } まで切る
            fragment = match.group()
            last_brace = fragment.rfind("}")
            if last_brace > 0:
                try:
                    return json.loads(fragment[:last_brace + 1] + "]")
                except json.JSONDecodeError:
                    pass

    return None
