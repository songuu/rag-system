#!/usr/bin/env python3
"""Add isolated RAG locations to the existing songuu.top gateway server.

The public root remains the gateway directory. RAG is served below
``/rag-system`` and its browser API calls use ``/rag-api/`` so neither the
legacy ``/api/`` nor ``/_next/`` namespace needs ambiguous request routing.
"""

import argparse
import datetime as dt
import re
import shutil
import sys
from pathlib import Path
from typing import Tuple


def find_block(text: str, start: str) -> Tuple[int, int, str]:
    """Return the one balanced nginx block whose header begins at *start*."""
    matches = [match.start() for match in re.finditer(re.escape(start), text)]
    if len(matches) != 1:
        raise RuntimeError(f"expected exactly one {start!r} block, found {len(matches)}")

    begin = matches[0]
    brace = text.find("{", begin)
    if brace < 0:
        raise RuntimeError(f"missing opening brace for {start!r}")

    depth = 0
    for index in range(brace, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                end = index + 1
                return begin, end, text[begin:end]
    raise RuntimeError(f"unterminated block for {start!r}")


def count_location(text: str, modifier: str, route: str) -> int:
    """Count an exact nginx location header without matching route prefixes."""
    pattern = re.compile(
        r"^[ \t]*location[ \t]+{}[ \t]+{}[ \t]*\{{".format(
            re.escape(modifier), re.escape(route)
        ),
        re.MULTILINE,
    )
    return len(pattern.findall(text))


def read_env_value(env_file: Path, name: str) -> str:
    prefix = f"{name}="
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith(prefix):
            value = line[len(prefix):].strip()
            if value:
                return value
    raise RuntimeError(f"{name} is missing from {env_file}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="/etc/nginx/conf.d/default.conf")
    parser.add_argument("--env-file", default="/opt/rag-system/shared/.env.production")
    parser.add_argument("--upstream", default="127.0.0.1:5182")
    args = parser.parse_args()

    config = Path(args.config)
    env_file = Path(args.env_file)
    token = read_env_value(env_file, "RAG_SINGLE_TENANT_TOKEN")
    if not re.fullmatch(r"[A-Za-z0-9._~+/-]{24,256}", token):
        raise RuntimeError("RAG_SINGLE_TENANT_TOKEN has an unsafe nginx header format")

    original = config.read_text(encoding="utf-8")
    existing_locations = {
        "root": count_location(original, "=", "/rag-system"),
        "direct_api": count_location(original, "^~", "/rag-system/api/"),
        "page": count_location(original, "^~", "/rag-system/"),
        "liveness": count_location(original, "=", "/rag-api/health/live"),
        "api": count_location(original, "^~", "/rag-api/"),
    }
    if any(existing_locations.values()):
        found = ", ".join(
            "{}={}".format(name, count)
            for name, count in existing_locations.items()
            if count
        )
        raise RuntimeError(
            "songuu RAG nginx locations already exist or are incomplete ({})".format(found)
        )

    root_begin, _, _ = find_block(original, "    location = / {")
    rag_locations = f'''    location = /rag-system {{
        if ($dm_authed = 0) {{ return 302 https://songuu.top/login; }}
        proxy_pass http://{args.upstream};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }}

    # Browser API requests must use /rag-api/, where the trusted server-side
    # bearer header is injected after the existing session gate. Do not expose
    # the compiled Next API namespace through the page proxy.
    location ^~ /rag-system/api/ {{
        return 404;
    }}

    location ^~ /rag-system/ {{
        if ($dm_authed = 0) {{ return 302 https://songuu.top/login; }}
        proxy_pass http://{args.upstream};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }}

    location = /rag-api/health/live {{
        proxy_pass http://{args.upstream}/rag-system/api/health/live;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }}

    location ^~ /rag-api/ {{
        if ($dm_authed = 0) {{ return 401; }}
        client_max_body_size 50m;
        proxy_pass http://{args.upstream}/rag-system/api/;
        proxy_http_version 1.1;
        proxy_set_header Authorization "Bearer {token}";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_buffering off;
        proxy_cache off;
    }}

'''
    text = original[:root_begin] + rag_locations + original[root_begin:]

    timestamp = dt.datetime.now().strftime("%Y%m%d%H%M%S")
    backup = config.with_name(f"{config.name}.bak.rag-system.{timestamp}")
    shutil.copy2(config, backup)
    config.write_text(text, encoding="utf-8")
    print(f"patched={config}")
    print(f"backup={backup}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - deployment scripts need an explicit cause.
        print(f"nginx patch aborted: {error}", file=sys.stderr)
        raise SystemExit(1)
