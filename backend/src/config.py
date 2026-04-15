from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", case_sensitive=False
    )

    # Application
    app_name: str = "Guidey"
    app_version: str = "0.1.0"
    debug: bool = False

    # LLM Provider
    llm_provider: Literal["ollama", "anthropic"] = "ollama"

    # Anthropic (used when llm_provider=anthropic)
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-5-20250514"

    # Ollama (used when llm_provider=ollama)
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "gemma4:e2b"       # 高速版 (リアルタイム判定用)
    ollama_hq_model: str = "gemma4:e2b"    # 高品質版 (将来: gemma4:26b or Claude)

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


settings = Settings()
