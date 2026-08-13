#!/usr/bin/env python3
"""Render host-safe runtime defaults from .env.container.example.

The example file describes a container topology.  This renderer retains every
active non-secret default, translates container-only addresses and persistence
paths for the songuu.top host, and deliberately leaves the real tenant token
in .env.prod. The output is shell-quoted because the PM2 runner sources
it before loading production overrides.
"""

import argparse
import re
from pathlib import Path


ASSIGNMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
ALLOWED_DEFAULT_PREFIXES = (
    "AZURE_OPENAI_", "COHERE_", "CONTEXTUAL_RETRIEVAL_", "CUSTOM_",
    "EMBEDDING_", "LANGCHAIN_", "LANGSMITH_", "LEMONADE_", "MAIC_",
    "MILVUS_", "MODEL_", "NOTION_", "OLLAMA_", "OPENAI_", "OPENROUTER_",
    "PDF_PARSE_", "RAG_", "REASONING_", "RERANK_", "RERANKER_",
    "SEMANTIC_CACHE_", "SILICONFLOW_", "VOYAGE_",
)
ALLOWED_DEFAULT_KEYS = {
    "FAST_LLM_MODEL", "HOSTNAME", "KEEP_ALIVE_TIMEOUT", "LLM_MODEL",
    "NEXT_PUBLIC_BASE_PATH", "NEXT_PUBLIC_LANGCHAIN_PROJECT",
    "NEXT_PUBLIC_LANGCHAIN_TRACING", "NEXT_TELEMETRY_DISABLED", "NODE_ENV",
    "PORT", "POSTGRES_CONNECTION_TIMEOUT_MS", "POSTGRES_DEFAULT_CORPUS_ID",
    "POSTGRES_DEFAULT_TENANT_ID", "POSTGRES_IDLE_TIMEOUT_MS",
    "POSTGRES_MAX_CONNECTIONS", "POSTGRES_SSL_MODE", "STATIC_EXPORT",
}
SKIP_KEYS = {
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_MIGRATION_URL",
    "RAG_SINGLE_TENANT_TOKEN",
}
HOST_OVERRIDES = {
    "HOSTNAME": "127.0.0.1",
    "PORT": "5182",
    "OLLAMA_BASE_URL": "http://127.0.0.1:11434",
    "MILVUS_LOCAL_ADDRESS": "127.0.0.1:19530",
    "RAG_DEFAULT_TENANT_ID": "songuu-production",
    "RAG_DEFAULT_CORPUS_ID": "default",
    "REASONING_RAG_UPLOAD_DIR": "/opt/rag-system/data/reasoning-uploads",
    "RAG_MIROFISH_GRAPH_STORE_ROOT": "/opt/rag-system/data/mirofish-graph-artifacts-v2",
    "RAG_PDF_VISUAL_STORE_ROOT": "/opt/rag-system/data/pdf-visual-assets-v1",
    "RAG_DURABLE_WORKFLOW_STORE_ROOT": "/opt/rag-system/data/rag-durable-workflows-v1",
}


def shell_quote(value: str) -> str:
    """Return a single-quoted Bash-safe value."""
    return "'{}'".format(value.replace("'", "'\"'\"'"))


def read_defaults(example: Path):
    values = {}
    for raw_line in example.read_text(encoding="utf-8").splitlines():
        match = ASSIGNMENT.match(raw_line)
        if not match:
            continue
        key, value = match.groups()
        if key in values:
            raise RuntimeError("duplicate active default: {}".format(key))
        # Only application runtime configuration belongs in the generated
        # defaults; database infrastructure credentials stay in secret files.
        if key not in SKIP_KEYS and (
            key in ALLOWED_DEFAULT_KEYS or key.startswith(ALLOWED_DEFAULT_PREFIXES)
        ):
            values[key] = HOST_OVERRIDES.get(key, value)
    return values


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("example", type=Path)
    args = parser.parse_args()

    defaults = read_defaults(args.example)
    print("# Generated from .env.container.example for the songuu.top host.")
    print("# .env.prod is loaded afterwards and overrides these defaults.")
    print("# Database URLs and RAG_SINGLE_TENANT_TOKEN stay only in .env.prod.")
    for key, value in defaults.items():
        print("{}={}".format(key, shell_quote(value)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
