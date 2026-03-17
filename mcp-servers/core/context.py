import logging
import asyncio
from pathlib import Path
from typing import Optional
from enum import Enum

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

from pydantic import BaseModel, Field

# Maximum file size to read for summaries (safety)
MAX_FILE_SIZE = 100_000
DEFAULT_REPO_ROOT = (Path(__file__).resolve().parent / "../..").resolve()

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
        "/usr/bin",
        "/usr/sbin",
        "/lib",
        "/lib64",
        "/lib32",
        "/libx32",
        "/run",
        "/snap",
    ]
]

# Patterns to silently skip when walking directories
IGNORED_NAMES = {
    ".git",
    "__pycache__",
    ".venv",
    "venv",
    ".env",
    ".idea",
    ".vscode",
    "dist",
    "build",
    ".pytest_cache",
    ".coverage",
    "htmlcov",
    ".DS_Store",
    "Thumbs.db",
    "node_modules",
    "*.egg-info",
}


class ContextBase(BaseModel):
    repo_path: str = Field(
        ...,
        description="Repository path. Relative paths are resolved from the project root; absolute paths are also allowed if safe.",
    )


class RepoTree(ContextBase):
    max_depth: int = Field(
        default=4,
        description="Maximum directory depth to explore",
    )


class FileSummary(ContextBase):
    file_path: str = Field(
        ...,
        description="File path relative to the repository root (must stay inside the repository)",
    )


class RepoSummary(ContextBase):
    pass


class ContextTools(str, Enum):
    REPO_TREE = "repo_tree"
    FILE_SUMMARY = "file_summary"
    REPO_SUMMARY = "repo_summary"


def is_blocked(path: Path) -> bool:
    """Return True if *path* falls inside (or is equal to) any BLOCKED_PATHS entry."""
    resolved = path.resolve()
    for blocked in BLOCKED_PATHS:
        try:
            resolved.relative_to(blocked.resolve())
            return True
        except ValueError:
            continue
    return False


def is_ignored_name(name: str) -> bool:
    """Return True if the file/dir name matches a known noise pattern."""
    import fnmatch

    for pattern in IGNORED_NAMES:
        if fnmatch.fnmatch(name, pattern):
            return True
    return False


def resolve_repo_path(repo_path: str, base_root: Path | None = None) -> Path:
    """
    Resolve *repo_path* to an absolute Path, rejecting blocked / unsafe locations.
    """
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


def generate_repo_tree(repo: Path, max_depth: int) -> str:
    lines = []

    def walk(directory: Path, depth: int):
        if depth > max_depth:
            return

        try:
            entries = sorted(directory.iterdir())
        except PermissionError:
            return

        for item in entries:
            if item.is_symlink():
                continue  # never follow symlinks
            if is_ignored_name(item.name):
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

    if file_path.is_symlink():
        raise ValueError(f"Refusing to read symlink: {file_path}")

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
    source_files = []
    for f in repo.rglob("*"):
        if f.is_symlink():
            continue
        if any(is_ignored_name(part) for part in f.parts):
            continue
        if f.is_file():
            source_files.append(f)

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
    base_root = repository.resolve() if repository else DEFAULT_REPO_ROOT

    if is_blocked(base_root):
        logger.error("Configured repository root is inside a protected path: %s", base_root)
        return

    if base_root.is_symlink():
        logger.error("Configured repository root cannot be a symbolic link: %s", base_root)
        return

    if not base_root.exists() or not base_root.is_dir():
        logger.error(f"Repository root does not exist or is not a directory: {base_root}")
        return

    logger.info(f"Using repository root at {base_root}")

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
        try:
            repo_path = resolve_repo_path(arguments["repo_path"], base_root)
        except ValueError as exc:
            raise ValueError(str(exc))

        if not repo_path.exists():
            raise ValueError(f"Repository path does not exist: {repo_path}")

        if not repo_path.is_dir():
            raise ValueError(f"Repository path is not a directory: {repo_path}")

        match name:

            case ContextTools.REPO_TREE:
                tree = generate_repo_tree(
                    repo_path,
                    arguments.get("max_depth", 4),
                )

                return [TextContent(type="text", text=tree)]

            case ContextTools.FILE_SUMMARY:
                file_path = (repo_path / arguments["file_path"]).resolve()

                try:
                    file_path.relative_to(repo_path)
                except ValueError:
                    raise ValueError("File path escapes repository scope")

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
        help="Optional project root used to resolve relative repository paths",
    )

    parsed = parser.parse_args()

    repo = Path(parsed.repository).resolve() if parsed.repository else DEFAULT_REPO_ROOT

    asyncio.run(serve(repo))
