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
SKIP_KEYS = {"RAG_SINGLE_TENANT_TOKEN"}
HOST_OVERRIDES = {
    "HOSTNAME": "127.0.0.1",
    "PORT": "5182",
    "OLLAMA_BASE_URL": "http://127.0.0.1:11434",
    "MILVUS_LOCAL_ADDRESS": "127.0.0.1:19530",
    "SUPABASE_DEFAULT_TENANT_ID": "songuu-production",
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
        if key not in SKIP_KEYS:
            values[key] = HOST_OVERRIDES.get(key, value)
    return values


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("example", type=Path)
    args = parser.parse_args()

    defaults = read_defaults(args.example)
    print("# Generated from .env.container.example for the songuu.top host.")
    print("# .env.prod is loaded afterwards and overrides these defaults.")
    print("# RAG_SINGLE_TENANT_TOKEN stays only in .env.prod.")
    for key, value in defaults.items():
        print("{}={}".format(key, shell_quote(value)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
