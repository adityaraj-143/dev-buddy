#!/bin/bash

# move into core directory
cd "$(dirname "$0")/../core"

echo "Starting filesystem MCP..."
uv run python filesystem.py . < /dev/stdin &

echo "Starting git MCP..."
uv run python gitTools.py < /dev/stdin &

wait