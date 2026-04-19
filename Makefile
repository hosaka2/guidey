.PHONY: help install \
	dev dev-be dev-mobile redis-up redis-down \
	gen-api \
	lint lint-be lint-mobile \
	format format-be format-mobile \
	typecheck typecheck-be typecheck-mobile \
	check

# ============================================================================
# Help
# ============================================================================

help: ## このヘルプを表示
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ============================================================================
# Setup
# ============================================================================

install: ## 依存関係をインストール (BE + モバイル)
	@echo "[install] backend ..."
	cd backend && uv sync
	@echo "[install] mobile ..."
	cd mobile && npm install
	@echo "[install] done."

# ============================================================================
# Dev
# ============================================================================

dev: ## BE + Redis をまとめて起動 (モバイルは別ターミナル)
	$(MAKE) redis-up
	$(MAKE) dev-be

dev-be: ## BE (FastAPI) を起動
	cd backend && .venv/bin/uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload

dev-mobile: ## モバイル (Expo) を起動
	cd mobile && npm run start

redis-up: ## Redis Stack (checkpointer 用) を Docker で起動
	@docker start redis-stack 2>/dev/null || \
	  docker run -d --name redis-stack --restart unless-stopped \
	    -p 6379:6379 redis/redis-stack-server:latest

redis-down: ## Redis Stack を停止
	docker stop redis-stack

# ============================================================================
# Codegen (OpenAPI → TS)
# ============================================================================

gen-api: ## BE の OpenAPI からモバイル用 TS 型を再生成 (BE が起動してる必要あり)
	@echo "[gen-api] fetching spec and generating lib/api/schema.ts ..."
	cd mobile && npm run gen:api
	$(MAKE) format-mobile

# ============================================================================
# Lint (checks only)
# ============================================================================

lint: lint-be lint-mobile ## 全プロジェクトを lint チェック

lint-be: ## BE: ruff check
	cd backend && .venv/bin/ruff check src/

lint-mobile: ## Mobile: expo lint
	cd mobile && npm run lint

# ============================================================================
# Format (write fixes)
# ============================================================================

format: format-be format-mobile ## 全プロジェクトを format + lint --fix

format-be: ## BE: ruff format + check --fix
	cd backend && .venv/bin/ruff format src/ && .venv/bin/ruff check --fix src/

format-mobile: ## Mobile: expo lint --fix
	cd mobile && npm run lint:fix

# ============================================================================
# Typecheck
# ============================================================================

typecheck: typecheck-be typecheck-mobile ## 全プロジェクトを型チェック

typecheck-be: ## BE: pyright
	cd backend && .venv/bin/pyright src/

typecheck-mobile: ## Mobile: tsc --noEmit
	cd mobile && npm run typecheck

# ============================================================================
# Aggregated
# ============================================================================

check: lint typecheck ## lint + typecheck (CI 用)
