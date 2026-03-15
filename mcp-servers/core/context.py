import logging
import asyncio
from pathlib import Path
from typing import Optional
from enum import Enum

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

from pydantic import BaseModel, Field

# Fixed workspace scope (same idea as git server)
WORKSPACE_SCOPE = (Path(__file__).resolve().parent / "../../workspace").resolve()

# Maximum file size to read for summaries (safety)
MAX_FILE_SIZE = 100_000


class ContextBase(BaseModel):
    repo_path: str = Field(
        ...,
        description="Repository path relative to the fixed workspace scope",
    )


class RepoTree(ContextBase):
    max_depth: int = Field(
        default=4,
        description="Maximum directory depth to explore",
    )


class FileSummary(ContextBase):
    file_path: str = Field(
        ...,
        description="File path relative to repository root",
    )


class RepoSummary(ContextBase):
    pass


class ContextTools(str, Enum):
    REPO_TREE = "repo_tree"
    FILE_SUMMARY = "file_summary"
    REPO_SUMMARY = "repo_summary"


def validate_repo_path(repo_path: Path, allowed_repository: Path) -> None:
    try:
        resolved_repo = repo_path.resolve()
        resolved_allowed = allowed_repository.resolve()
    except (OSError, RuntimeError):
        raise ValueError(f"Invalid path: {repo_path}")

    try:
        resolved_repo.relative_to(resolved_allowed)
    except ValueError:
        raise ValueError(
            f"Repository path '{repo_path}' is outside allowed workspace '{allowed_repository}'"
        )


def resolve_scoped_repo_path(repo_path: str, scope_root: Path) -> Path:
    candidate = Path(repo_path)

    if candidate.is_absolute():
        resolved = candidate.resolve()
    else:
        resolved = (scope_root / candidate).resolve()

    validate_repo_path(resolved, scope_root)
    return resolved


def generate_repo_tree(repo: Path, max_depth: int) -> str:
    lines = []

    def walk(directory: Path, depth: int):
        if depth > max_depth:
            return

        for item in sorted(directory.iterdir()):
            if item.name.startswith(".git"):
                continue

            indent = "  " * depth
            lines.append(f"{indent}{item.name}")

            if item.is_dir():
                walk(item, depth + 1)

    walk(repo, 0)
    return "\n".join(lines)


def summarize_file(file_path: Path) -> str:
    if not file_path.exists():
        raise ValueError(f"File does not exist: {file_path}")

    if file_path.stat().st_size > MAX_FILE_SIZE:
        return f"File too large to summarize safely: {file_path.name}"

    try:
        content = file_path.read_text(errors="ignore")
    except Exception:
        return f"Unable to read file: {file_path.name}"

    lines = content.splitlines()

    imports = []
    functions = []
    classes = []

    for line in lines:
        stripped = line.strip()

        if stripped.startswith("import ") or stripped.startswith("from "):
            imports.append(stripped)

        if stripped.startswith("def "):
            functions.append(stripped)

        if stripped.startswith("class "):
            classes.append(stripped)

    summary = [
        f"File: {file_path.name}",
        f"Total lines: {len(lines)}",
    ]

    if imports:
        summary.append("\nImports:")
        summary.extend(imports[:10])

    if classes:
        summary.append("\nClasses:")
        summary.extend(classes[:10])

    if functions:
        summary.append("\nFunctions:")
        summary.extend(functions[:15])

    return "\n".join(summary)


def generate_repo_summary(repo: Path) -> str:
    files = list(repo.rglob("*"))

    source_files = [f for f in files if f.is_file() and not ".git" in str(f)]

    extensions = {}

    for f in source_files:
        ext = f.suffix or "no_extension"
        extensions[ext] = extensions.get(ext, 0) + 1

    summary = [
        f"Repository: {repo.name}",
        f"Total files: {len(source_files)}",
        "\nFile types:",
    ]

    for ext, count in sorted(extensions.items(), key=lambda x: x[1], reverse=True):
        summary.append(f"{ext}: {count}")

    important_files = ["README.md", "package.json", "pyproject.toml"]

    summary.append("\nImportant files present:")

    for name in important_files:
        if (repo / name).exists():
            summary.append(name)

    return "\n".join(summary)


async def serve(repository: Path | None) -> None:
    logger = logging.getLogger(__name__)
    scope_root = WORKSPACE_SCOPE

    if not scope_root.exists() or not scope_root.is_dir():
        logger.error(
            f"Workspace scope does not exist or is not a directory: {scope_root}"
        )
        return

    logger.info(f"Using workspace scope at {scope_root}")

    server = Server("mcp-context")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(
                name=ContextTools.REPO_TREE,
                description="""
Return the directory tree of the repository.

Useful for understanding project structure.

Example:
- Show repository layout
""",
                inputSchema=RepoTree.model_json_schema(),
            ),
            Tool(
                name=ContextTools.FILE_SUMMARY,
                description="""
Generate a structural summary of a file.

Extracts:
- imports
- classes
- functions
- line counts

Useful for quickly understanding file purpose.
""",
                inputSchema=FileSummary.model_json_schema(),
            ),
            Tool(
                name=ContextTools.REPO_SUMMARY,
                description="""
Generate a high level repository summary.

Shows:
- file counts
- file types
- important project files
""",
                inputSchema=RepoSummary.model_json_schema(),
            ),
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict):
        repo_path = resolve_scoped_repo_path(arguments["repo_path"], scope_root)

        if not repo_path.exists():
            raise ValueError(f"Repository path does not exist: {repo_path}")

        match name:

            case ContextTools.REPO_TREE:
                tree = generate_repo_tree(
                    repo_path,
                    arguments.get("max_depth", 4),
                )

                return [TextContent(type="text", text=tree)]

            case ContextTools.FILE_SUMMARY:
                file_path = repo_path / arguments["file_path"]

                summary = summarize_file(file_path)

                return [TextContent(type="text", text=summary)]

            case ContextTools.REPO_SUMMARY:
                summary = generate_repo_summary(repo_path)

                return [TextContent(type="text", text=summary)]

            case _:
                raise ValueError(f"Unknown tool: {name}")

    options = server.create_initialization_options()

    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, options, raise_exceptions=True)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Run MCP Context tools server over stdio"
    )

    parser.add_argument(
        "repository",
        nargs="?",
        default=None,
        help="Optional repository path under workspace",
    )

    parsed = parser.parse_args()

    repo = Path(parsed.repository).resolve() if parsed.repository else None

    asyncio.run(serve(repo))
