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
# Repository access policy
ALLOW_LLM_REPO_PATH = False

class BranchType(str, Enum):
    LOCAL = "local"
    REMOTE = "remote"
    ALL = "all"

class GitBase(BaseModel):
    repo_path: str = Field(..., description="Path to the Git repository")


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
        default= BranchType.LOCAL,
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


def validate_repo_path(repo_path: Path, allowed_repository: Path | None) -> None:
    """Validate repository access policy."""

    # If unrestricted mode enabled, skip validation
    if ALLOW_LLM_REPO_PATH:
        return

    if allowed_repository is None:
        raise ValueError(
            "Repository access is restricted but no allowed repository configured"
        )

    try:
        resolved_repo = repo_path.resolve()
        resolved_allowed = allowed_repository.resolve()
    except (OSError, RuntimeError):
        raise ValueError(f"Invalid path: {repo_path}")

    try:
        resolved_repo.relative_to(resolved_allowed)
    except ValueError:
        raise ValueError(
            f"Repository path '{repo_path}' is outside the allowed workspace '{allowed_repository}'"
        )


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

    if repository is not None:
        try:
            git.Repo(repository)
            logger.info(f"Using repository at {repository}")
        except git.InvalidGitRepositoryError:
            logger.error(f"{repository} is not a valid Git repository")
            return

    server = Server("mcp-git")

    @server.list_tools()
    async def list_tools() -> list[Tool]:
        return [
            Tool(
                name=GitTools.INIT,
                description="Initialize an empty Git repository",
                inputSchema=GitInit.model_json_schema(),
            ),
            Tool(
                name=GitTools.STATUS,
                description="Shows the working tree status",
                inputSchema=GitStatus.model_json_schema(),
            ),
            Tool(
                name=GitTools.DIFF_UNSTAGED,
                description="Shows changes in the working directory that are not yet staged",
                inputSchema=GitDiffUnstaged.model_json_schema(),
            ),
            Tool(
                name=GitTools.DIFF_STAGED,
                description="Shows changes that are staged for commit",
                inputSchema=GitDiffStaged.model_json_schema(),
            ),
            Tool(
                name=GitTools.DIFF,
                description="Shows differences between branches or commits",
                inputSchema=GitDiff.model_json_schema(),
            ),
            Tool(
                name=GitTools.COMMIT,
                description="Records changes to the repository",
                inputSchema=GitCommit.model_json_schema(),
            ),
            Tool(
                name=GitTools.ADD,
                description="Adds file contents to the staging area",
                inputSchema=GitAdd.model_json_schema(),
            ),
            Tool(
                name=GitTools.RESET,
                description="Unstages all staged changes",
                inputSchema=GitReset.model_json_schema(),
            ),
            Tool(
                name=GitTools.LOG,
                description="Shows the commit logs",
                inputSchema=GitLog.model_json_schema(),
            ),
            Tool(
                name=GitTools.CREATE_BRANCH,
                description="Creates a new branch from an optional base branch",
                inputSchema=GitCreateBranch.model_json_schema(),
            ),
            Tool(
                name=GitTools.CHECKOUT,
                description="Switches branches",
                inputSchema=GitCheckout.model_json_schema(),
            ),
            Tool(
                name=GitTools.SHOW,
                description="Shows the contents of a commit",
                inputSchema=GitShow.model_json_schema(),
            ),
            Tool(
                name=GitTools.BRANCH,
                description="List Git branches",
                inputSchema=GitBranch.model_json_schema(),
            ),
        ]
        
        async def by_roots() -> Sequence[str]:
            if not isinstance(server.request_context.session, ServerSession):
                raise TypeError(
                    "server.request_context.session must be a ServerSession"
                )

            if not server.request_context.session.check_client_capability(
                ClientCapabilities(roots=RootsCapability())
            ):
                return []

            roots_result: ListRootsResult = (
                await server.request_context.session.list_roots()
            )
            logger.debug(f"Roots result: {roots_result}")
            repo_paths = []
            for root in roots_result.roots:
                path = root.uri.path
                try:
                    git.Repo(path)
                    repo_paths.append(str(path))
                except git.InvalidGitRepositoryError:
                    pass
            return repo_paths

        def by_commandline() -> Sequence[str]:
            return [str(repository)] if repository is not None else []

        cmd_repos = by_commandline()
        root_repos = await by_roots()
        return [*root_repos, *cmd_repos]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list[TextContent]:
        repo_path = Path(arguments["repo_path"])

        # Validate repo_path is within allowed repository
        validate_repo_path(repo_path, repository)

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

    parser = argparse.ArgumentParser(
        description="Run MCP Git tools server over stdio"
    )
    parser.add_argument(
        "repository",
        nargs="?",
        default=None,
        help="Optional repository path to allow access under",
    )
    parsed = parser.parse_args()

    repo = Path(parsed.repository).resolve() if parsed.repository else None
    asyncio.run(serve(repo))
