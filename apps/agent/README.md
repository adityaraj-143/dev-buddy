# agent

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run dev
```

The agent now auto-connects to both MCP servers (filesystem + git) without CLI args.

Optional environment variables:

- `OLLAMA_BASE_URL` (default: `http://localhost:11434/v1`)
- `MCP_CORE_CWD` (default: `../../mcp-servers/core` from `apps/agent`)
- `MCP_FILESYSTEM_ROOT` (default: `<repo-root>/workspace`)
- `MCP_GIT_REPO` (default: `<repo-root>`)

Example:

```bash
OLLAMA_BASE_URL=http://localhost:11434/v1 \
MCP_FILESYSTEM_ROOT=. \
MCP_GIT_REPO=. \
bun run dev
```

This project was created using `bun init` in bun v1.3.8. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
