import logging
import asyncio
from pathlib import Path
from typing import Sequence, Optional
from mcp.server import Server
from mcp.server.session import ServerSession
from mcp.server.stdio import stdio_server
from mcp.types import (
    ClientCapabilities,
    TextContent,
    Tool,
    ListRootsResult,
    RootsCapability,
)
from enum import Enum
import git
from git.exc import BadName
from pydantic import BaseModel, Field

# Default number of context lines to show in diff output
DEFAULT_CONTEXT_LINES = 3
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
        "/usr",
        "/lib",
        "/lib64",
        "/lib32",
        "/libx32",
        "/run",
        "/snap",
    ]
]


class BranchType(str, Enum):
    LOCAL = "local"
    REMOTE = "remote"
    ALL = "all"


class GitBase(BaseModel):
    repo_path: str = Field(
        ...,
        description="Repository path. Relative paths are resolved from the project root; absolute paths are also allowed if safe.",
    )


class GitStatus(GitBase):
    pass


class GitDiffUnstaged(GitBase):
    context_lines: int = DEFAULT_CONTEXT_LINES


class GitDiffStaged(GitBase):
    context_lines: int = DEFAULT_CONTEXT_LINES


class GitDiff(GitBase):
    target: str
    context_lines: int = DEFAULT_CONTEXT_LINES


class GitCommit(GitBase):
    message: str


class GitAdd(GitBase):
    files: list[str]


class GitReset(GitBase):
    pass


class GitInit(GitBase):
    pass


class GitLog(GitBase):
    max_count: int = 10
    start_timestamp: Optional[str] = Field(
        None,
        description="Start timestamp for filtering commits. Accepts: ISO 8601 format (e.g., '2024-01-15T14:30:25'), relative dates (e.g., '2 weeks ago', 'yesterday'), or absolute dates (e.g., '2024-01-15', 'Jan 15 2024')",
    )
    end_timestamp: Optional[str] = Field(
        None,
        description="End timestamp for filtering commits. Accepts: ISO 8601 format (e.g., '2024-01-15T14:30:25'), relative dates (e.g., '2 weeks ago', 'yesterday'), or absolute dates (e.g., '2024-01-15', 'Jan 15 2024')",
    )


class GitCreateBranch(GitBase):
    branch_name: str
    base_branch: str | None = None


class GitCheckout(GitBase):
    branch_name: str


class GitShow(GitBase):
    revision: str


class GitBranch(GitBase):
    branch_type: BranchType = Field(
        default=BranchType.LOCAL,
        description="Whether to list local branches ('local'), remote branches ('remote') or all branches('all').",
    )
    contains: Optional[str] = Field(
        None,
        description="The commit sha that branch should contain. Do not pass anything to this param if no commit sha is specified",
    )
    not_contains: Optional[str] = Field(
        None,
        description="The commit sha that branch should NOT contain. Do not pass anything to this param if no commit sha is specified",
    )


class GitTools(str, Enum):
    INIT = "git_init"
    STATUS = "git_status"
    DIFF_UNSTAGED = "git_diff_unstaged"
    DIFF_STAGED = "git_diff_staged"
    DIFF = "git_diff"
    COMMIT = "git_commit"
    ADD = "git_add"
    RESET = "git_reset"
    LOG = "git_log"
    CREATE_BRANCH = "git_create_branch"
    CHECKOUT = "git_checkout"
    SHOW = "git_show"
    BRANCH = "git_branch"


def git_status(repo: git.Repo) -> str:
    return repo.git.status()


def git_diff_unstaged(
    repo: git.Repo, context_lines: int = DEFAULT_CONTEXT_LINES
) -> str:
    return repo.git.diff(f"--unified={context_lines}")


def git_diff_staged(repo: git.Repo, context_lines: int = DEFAULT_CONTEXT_LINES) -> str:
    return repo.git.diff(f"--unified={context_lines}", "--cached")


def git_diff(
    repo: git.Repo, target: str, context_lines: int = DEFAULT_CONTEXT_LINES
) -> str:
    # Defense in depth: reject targets starting with '-' to prevent flag injection,
    # even if a malicious ref with that name exists (e.g. via filesystem manipulation)
    if target.startswith("-"):
        raise BadName(f"Invalid target: '{target}' - cannot start with '-'")
    repo.rev_parse(target)  # Validates target is a real git ref, throws BadName if not
    return repo.git.diff(f"--unified={context_lines}", target)


def git_commit(repo: git.Repo, message: str) -> str:
    commit = repo.index.commit(message)
    return f"Changes committed successfully with hash {commit.hexsha}"


def git_add(repo: git.Repo, files: list[str]) -> str:
    if files == ["."]:
        repo.git.add(".")
    else:
        # Use '--' to prevent files starting with '-' from being interpreted as options
        repo.git.add("--", *files)
    return "Files staged successfully"


def git_reset(repo: git.Repo) -> str:
    repo.index.reset()
    return "All staged changes reset"


def git_init(repo_path: Path) -> str:
    if repo_path.exists() and repo_path.is_file():
        raise ValueError(f"Path is a file, expected directory: {repo_path}")

    repo_path.mkdir(parents=True, exist_ok=True)

    try:
        git.Repo(repo_path)
        return f"Git repository already exists at {repo_path}"
    except git.InvalidGitRepositoryError:
        git.Repo.init(repo_path)
        return f"Initialized empty Git repository at {repo_path}"


def git_log(
    repo: git.Repo,
    max_count: int = 10,
    start_timestamp: Optional[str] = None,
    end_timestamp: Optional[str] = None,
) -> list[str]:
    if start_timestamp or end_timestamp:
        # Use git log command with date filtering
        args = []
        if start_timestamp:
            args.extend(["--since", start_timestamp])
        if end_timestamp:
            args.extend(["--until", end_timestamp])
        args.extend(["--format=%H%n%an%n%ad%n%s%n"])

        log_output = repo.git.log(*args).split("\n")

        log = []
        # Process commits in groups of 4 (hash, author, date, message)
        for i in range(0, len(log_output), 4):
            if i + 3 < len(log_output) and len(log) < max_count:
                log.append(
                    f"Commit: {log_output[i]}\n"
                    f"Author: {log_output[i+1]}\n"
                    f"Date: {log_output[i+2]}\n"
                    f"Message: {log_output[i+3]}\n"
                )
        return log
    else:
        # Use existing logic for simple log without date filtering
        commits = list(repo.iter_commits(max_count=max_count))
        log = []
        for commit in commits:
            log.append(
                f"Commit: {commit.hexsha!r}\n"
                f"Author: {commit.author!r}\n"
                f"Date: {commit.authored_datetime}\n"
                f"Message: {commit.message!r}\n"
            )
        return log


def git_create_branch(
    repo: git.Repo, branch_name: str, base_branch: str | None = None
) -> str:
    if base_branch:
        base = repo.references[base_branch]
    else:
        base = repo.active_branch

    repo.create_head(branch_name, base)
    return f"Created branch '{branch_name}' from '{base.name}'"


def git_checkout(repo: git.Repo, branch_name: str) -> str:
    # Defense in depth: reject branch names starting with '-' to prevent flag injection,
    # even if a malicious ref with that name exists (e.g. via filesystem manipulation)
    if branch_name.startswith("-"):
        raise BadName(f"Invalid branch name: '{branch_name}' - cannot start with '-'")
    repo.rev_parse(
        branch_name
    )  # Validates branch_name is a real git ref, throws BadName if not
    repo.git.checkout(branch_name)
    return f"Switched to branch '{branch_name}'"


def git_show(repo: git.Repo, revision: str) -> str:
    commit = repo.commit(revision)
    output = [
        f"Commit: {commit.hexsha!r}\n"
        f"Author: {commit.author!r}\n"
        f"Date: {commit.authored_datetime!r}\n"
        f"Message: {commit.message!r}\n"
    ]
    if commit.parents:
        parent = commit.parents[0]
        diff = parent.diff(commit, create_patch=True)
    else:
        diff = commit.diff(git.NULL_TREE, create_patch=True)
    for d in diff:
        output.append(f"\n--- {d.a_path}\n+++ {d.b_path}\n")

        if d.diff is None:
            continue

        diff_content = d.diff

        if isinstance(diff_content, memoryview):
            diff_content = diff_content.tobytes()

        if isinstance(diff_content, (bytes, bytearray)):
            diff_content = diff_content.decode("utf-8", errors="replace")

        output.append(str(diff_content))
    return "".join(output)


def is_blocked(path: Path) -> bool:
    resolved = path.resolve()
    for blocked in BLOCKED_PATHS:
        try:
            resolved.relative_to(blocked.resolve())
            return True
        except ValueError:
            continue
    return False


def resolve_repo_path(repo_path: str, base_root: Path | None = None) -> Path:
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


def git_branch(
    repo: git.Repo,
    branch_type: str,
    contains: str | None = None,
    not_contains: str | None = None,
) -> str:
    args = []

    if contains:
        args.extend(["--contains", contains])

    if not_contains:
        args.extend(["--no-contains", not_contains])

    match branch_type:
        case "local":
            b_type = None
        case "remote":
            b_type = "-r"
        case "all":
            b_type = "-a"
        case _:
            return f"Invalid branch type: {branch_type}"

    # None value will be auto deleted by GitPython
    branch_info = repo.git.branch(b_type, *args)

    return branch_info


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
            f"Repository root does not exist or is not a directory: {base_root}"
        )
        return

    logger.info(f"Using repository root at {base_root}")

    server = Server("mcp-git")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(
                name=GitTools.INIT,
                description="""
        Initialize a new empty Git repository in the current directory.

        Use this when starting version control for a project.

        Example:
        - Initialize repository: {}
        """,
                inputSchema=GitInit.model_json_schema(),
            ),
            Tool(
                name=GitTools.STATUS,
                description="""
        Show the current state of the working directory and staging area.

        Displays:
        - Modified files
        - Staged files
        - Untracked files
        - Current branch

        Example:
        - Check repository status: {}
        """,
                inputSchema=GitStatus.model_json_schema(),
            ),
            Tool(
                name=GitTools.DIFF_UNSTAGED,
                description="""
        Show changes in the working directory that are NOT staged yet.

        Useful for reviewing edits before staging them.

        Example:
        - Show unstaged changes: {}
        """,
                inputSchema=GitDiffUnstaged.model_json_schema(),
            ),
            Tool(
                name=GitTools.DIFF_STAGED,
                description="""
        Show changes that are currently staged for the next commit.

        Useful for verifying what will be included in the commit.

        Example:
        - Show staged changes: {}
        """,
                inputSchema=GitDiffStaged.model_json_schema(),
            ),
            Tool(
                name=GitTools.DIFF,
                description="""
        Show differences between commits, branches, or specific references.

        Useful for reviewing code changes across branches or history.

        Examples:
        - Compare two branches
        - Compare two commits
        - Compare working tree with a commit
        """,
                inputSchema=GitDiff.model_json_schema(),
            ),
            Tool(
                name=GitTools.COMMIT,
                description="""
        Record staged changes to the repository as a new commit.

        A commit saves the current staged snapshot of the project.

        Examples:
        - Commit staged changes with message
        - Create a checkpoint in project history

        You must provide a commit message.
        """,
                inputSchema=GitCommit.model_json_schema(),
            ),
            Tool(
                name=GitTools.ADD,
                description="""
        Stage files for commit.

        Moves file changes from the working directory to the staging area.

        Examples:
        - Stage all changes: files=["."]
        - Stage specific files: files=["file1.py","file2.py"]

        You must always provide 'files'.
        """,
                inputSchema=GitAdd.model_json_schema(),
            ),
            Tool(
                name=GitTools.RESET,
                description="""
        Unstage files that were previously added to the staging area.

        This moves changes from the staging area back to the working directory
        without modifying the actual file contents.

        Example:
        - Unstage all staged files
        """,
                inputSchema=GitReset.model_json_schema(),
            ),
            Tool(
                name=GitTools.LOG,
                description="""
        Show the commit history of the repository.

        Displays:
        - Commit hashes
        - Commit messages
        - Authors
        - Dates

        Useful for exploring project history.

        Example:
        - View commit history
        """,
                inputSchema=GitLog.model_json_schema(),
            ),
            Tool(
                name=GitTools.CREATE_BRANCH,
                description="""
        Create a new Git branch.

        The new branch can optionally be created from a specified base branch.

        Examples:
        - Create branch from current branch
        - Create branch from another branch

        Useful for starting new features or experiments.
        """,
                inputSchema=GitCreateBranch.model_json_schema(),
            ),
            Tool(
                name=GitTools.CHECKOUT,
                description="""
        Switch to another branch in the repository.

        This updates the working directory to match the selected branch.

        Examples:
        - Switch to an existing branch
        - Move working directory to another branch's state
        """,
                inputSchema=GitCheckout.model_json_schema(),
            ),
            Tool(
                name=GitTools.SHOW,
                description="""
        Show detailed information about a specific commit.

        Displays:
        - Commit metadata
        - Commit message
        - File changes introduced by the commit

        Example:
        - Inspect a commit using its hash
        """,
                inputSchema=GitShow.model_json_schema(),
            ),
            Tool(
                name=GitTools.BRANCH,
                description="""
        List all branches in the repository.

        Shows:
        - Local branches
        - Current active branch

        Example:
        - View all available branches
        """,
                inputSchema=GitBranch.model_json_schema(),
            ),
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        repo_path = resolve_repo_path(arguments["repo_path"], base_root)

        if name == GitTools.INIT:
            result = git_init(repo_path)
            return [TextContent(type="text", text=result)]

        # For all commands, we need an existing repo
        if not repo_path.exists():
            raise ValueError(f"Repository path does not exist: {repo_path}")

        try:
            repo = git.Repo(repo_path)
        except git.InvalidGitRepositoryError:
            raise ValueError(f"Not a git repository: {repo_path}")

        match name:
            case GitTools.STATUS:
                status = git_status(repo)
                return [TextContent(type="text", text=f"Repository status:\n{status}")]

            case GitTools.DIFF_UNSTAGED:
                diff = git_diff_unstaged(
                    repo, arguments.get("context_lines", DEFAULT_CONTEXT_LINES)
                )
                return [TextContent(type="text", text=f"Unstaged changes:\n{diff}")]

            case GitTools.DIFF_STAGED:
                diff = git_diff_staged(
                    repo, arguments.get("context_lines", DEFAULT_CONTEXT_LINES)
                )
                return [TextContent(type="text", text=f"Staged changes:\n{diff}")]

            case GitTools.DIFF:
                diff = git_diff(
                    repo,
                    arguments["target"],
                    arguments.get("context_lines", DEFAULT_CONTEXT_LINES),
                )
                return [
                    TextContent(
                        type="text", text=f"Diff with {arguments['target']}:\n{diff}"
                    )
                ]

            case GitTools.COMMIT:
                result = git_commit(repo, arguments["message"])
                return [TextContent(type="text", text=result)]

            case GitTools.ADD:
                result = git_add(repo, arguments["files"])
                return [TextContent(type="text", text=result)]

            case GitTools.RESET:
                result = git_reset(repo)
                return [TextContent(type="text", text=result)]

            # Update the LOG case:
            case GitTools.LOG:
                log = git_log(
                    repo,
                    arguments.get("max_count", 10),
                    arguments.get("start_timestamp"),
                    arguments.get("end_timestamp"),
                )
                return [
                    TextContent(type="text", text="Commit history:\n" + "\n".join(log))
                ]

            case GitTools.CREATE_BRANCH:
                result = git_create_branch(
                    repo, arguments["branch_name"], arguments.get("base_branch")
                )
                return [TextContent(type="text", text=result)]

            case GitTools.CHECKOUT:
                result = git_checkout(repo, arguments["branch_name"])
                return [TextContent(type="text", text=result)]

            case GitTools.SHOW:
                result = git_show(repo, arguments["revision"])
                return [TextContent(type="text", text=result)]

            case GitTools.BRANCH:
                result = git_branch(
                    repo,
                    arguments.get("branch_type", "local"),
                    arguments.get("contains", None),
                    arguments.get("not_contains", None),
                )
                return [TextContent(type="text", text=result)]

            case _:
                raise ValueError(f"Unknown tool: {name}")

    options = server.create_initialization_options()
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, options, raise_exceptions=True)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run MCP Git tools server over stdio")
    parser.add_argument(
        "repository",
        nargs="?",
        default=None,
        help="Optional project root used to resolve relative repository paths",
    )
    parsed = parser.parse_args()

    repo = Path(parsed.repository).resolve() if parsed.repository else DEFAULT_REPO_ROOT
    asyncio.run(serve(repo))
