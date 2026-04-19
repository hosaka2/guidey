from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", case_sensitive=False)

    # Application
    app_name: str = "Guidey"
    app_version: str = "0.1.0"
    debug: bool = False

    # LLM Provider
    llm_provider: Literal["ollama", "anthropic"] = "ollama"
    hq_provider: Literal["ollama", "anthropic", ""] = ""  # 未設定→llm_providerにフォールバック

    # Anthropic (used when llm_provider=anthropic)
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-5-20250514"

    # Ollama (used when llm_provider=ollama)
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "gemma4:e4b"  # 高速版 (リアルタイム判定用)
    ollama_hq_model: str = "gemma4:e4b"  # 高品質版 (将来: gemma4:26b or Claude)

    # CORS (dev: allow all origins for mobile app access via ngrok)
    cors_origins: list[str] = ["*"]

    # API
    api_prefix: str = ""

    # Embeddings
    embedding_model: str = "nomic-embed-text"

    # Static files
    static_dir: str = "./static"

    # Milvus
    milvus_db_path: str = "./db/guidey.db"

    # LangSmith (env: LANGCHAIN_TRACING_V2, LANGCHAIN_API_KEY, LANGCHAIN_PROJECT)
    # LangChain が自動検出するので config に持つ必要なし。.env に書くだけ。

    # Redis 8+ (langgraph-checkpoint-redis が RedisJSON/RediSearch を要求)
    redis_url: str = "redis://localhost:6379/0"
    session_ttl_min: int = 30  # Checkpointer TTL (分単位)

    # --- Harness ---
    # パイプラインタイムアウト (秒)
    pipeline_timeout_periodic: float = 30.0
    pipeline_timeout_user_action: float = 60.0
    # セッション単位のコスト上限
    session_max_stage2_calls: int = 30  # Stage2 の最大呼び出し回数/セッション
    session_max_total_calls: int = 500  # 全パイプライン呼び出し上限/セッション
    # LLM出力制限
    max_response_length: int = 500  # message の最大文字数
    max_blocks_per_response: int = 5  # 1応答あたりの最大ブロック数


settings = Settings()
