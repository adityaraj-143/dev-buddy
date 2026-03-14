#!/bin/bash

cd "$(dirname "$0")"

echo "Starting filesystem MCP..."
uv run python ../core/filesystem.py . < /dev/stdin &

echo "Starting git MCP..."
uv run python ../core/gitTools.py < /dev/stdin &

wait