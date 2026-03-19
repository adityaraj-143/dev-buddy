import asyncio
import logging
from enum import Enum
from pathlib import Path
from typing import Iterator

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool
from pydantic import BaseModel, Field

DEFAULT_REPO_ROOT = (Path(__file__).resolve().parent / "../..").resolve()
ALLOWED_EXTENSIONS = {".ts", ".js", ".py", ".json", ".md"}

# Absolute paths that are never allowed to be accessed
BLOCKED_PATHS: list[Path] = [
    Path(p)
    for p in [
        "/etc",
        "/sys",
        "/proc",
        "/dev",
        "/boot",
        "/root",
        "/bin",
        "/sbin",
        "/usr",
        "/lib",
        "/lib64",
        "/lib32",
        "/libx32",
        "/run",
        "/snap",
    ]
]


class SearchBase(BaseModel):
    repo_path: str = Field(
        ...,
        description="Repository path. Relative paths are resolved from the project root; absolute paths are also allowed if safe.",
    )


class SearchInput(SearchBase):
    query: str = Field(..., description="Case-insensitive text to search for")


class SearchTools(str, Enum):
    SEARCH_FILES = "search_files"
    SEARCH_CODE = "search_code"


def is_blocked(path: Path) -> bool:
    """Return True if *path* falls inside (or is equal to) any blocked path."""
    resolved = path.resolve()
    for blocked in BLOCKED_PATHS:
        try:
            resolved.relative_to(blocked.resolve())
            return True
        except ValueError:
            continue
    return False


def resolve_repo_path(repo_path: str, base_root: Path | None = None) -> Path:
    """Resolve *repo_path* to an absolute path, rejecting blocked locations."""
    candidate = Path(repo_path)

    if candidate.is_absolute():
        resolved = candidate.resolve()
    else:
        resolved = ((base_root or DEFAULT_REPO_ROOT) / candidate).resolve()

    if is_blocked(resolved):
        raise ValueError(
            f"Access denied: '{resolved}' is inside a protected system path."
        )

    if resolved.is_symlink():
        raise ValueError(f"Access denied: '{resolved}' is a symbolic link.")

    return resolved


def iter_searchable_files(root: Path) -> Iterator[Path]:
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        if path.suffix.lower() in ALLOWED_EXTENSIONS:
            yield path


def search_files_by_content(repo_path: Path, query: str) -> list[str]:
    results: list[str] = []
    query_lower = query.lower()

    for file_path in iter_searchable_files(repo_path):
        try:
            content = file_path.read_text(encoding="utf-8").lower()
        except (OSError, UnicodeDecodeError):
            continue

        if query_lower in content:
            results.append(str(file_path))

    return results[:20]


def search_code_snippets(repo_path: Path, query: str) -> list[str]:
    results: list[str] = []
    query_lower = query.lower()

    for file_path in iter_searchable_files(repo_path):
        try:
            lines = file_path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue

        for index, line in enumerate(lines, start=1):
            if query_lower in line.lower():
                snippet = line.strip()
                results.append(f"{file_path}:{index} -> {snippet}")

    return results[:30]


async def serve(repository: Path | None) -> None:
    logger = logging.getLogger(__name__)
    base_root = repository.resolve() if repository else DEFAULT_REPO_ROOT

    if is_blocked(base_root):
        logger.error(
            "Configured repository root is inside a protected path: %s", base_root
        )
        return

    if base_root.is_symlink():
        logger.error(
            "Configured repository root cannot be a symbolic link: %s", base_root
        )
        return

    if not base_root.exists() or not base_root.is_dir():
        logger.error(
            "Repository root does not exist or is not a directory: %s", base_root
        )
        return

    logger.info("Using repository root at %s", base_root)

    server = Server("mcp-search")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(
                name=SearchTools.SEARCH_FILES,
                description="""
Search for files whose contents include a query string.

Returns matching file paths.
""",
                inputSchema=SearchInput.model_json_schema(),
            ),
            Tool(
                name=SearchTools.SEARCH_CODE,
                description="""
Search for query matches line-by-line in source files.

Returns file, line number, and matching snippet.
""",
                inputSchema=SearchInput.model_json_schema(),
            ),
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        repo_path = resolve_repo_path(arguments["repo_path"], base_root)

        if not repo_path.exists():
            raise ValueError(f"Repository path does not exist: {repo_path}")

        if not repo_path.is_dir():
            raise ValueError(f"Repository path is not a directory: {repo_path}")

        match name:
            case SearchTools.SEARCH_FILES:
                matches = search_files_by_content(repo_path, arguments["query"])
                text = "\n".join(matches)
                return [TextContent(type="text", text=text)]

            case SearchTools.SEARCH_CODE:
                snippets = search_code_snippets(repo_path, arguments["query"])
                text = "\n".join(snippets)
                return [TextContent(type="text", text=text)]

            case _:
                raise ValueError(f"Unknown tool: {name}")

    options = server.create_initialization_options()
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, options, raise_exceptions=True)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run MCP Search tools server over stdio")
    parser.add_argument(
        "repository",
        nargs="?",
        default=None,
        help="Optional project root used to resolve relative repository paths",
    )
    parsed = parser.parse_args()

    repo = Path(parsed.repository).resolve() if parsed.repository else DEFAULT_REPO_ROOT
    asyncio.run(serve(repo))