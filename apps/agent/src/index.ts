import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import readline from 'readline/promises';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const SYSTEM_PROMPT = `You are an MCP-powered coding assistant with access to tools for interacting with a local codebase.

Your primary job is to understand and analyze THIS project using tools. You must rely on tools instead of prior knowledge whenever the question is about the codebase.

=====================
CORE RULES
=====================

- If the question is about THIS project, ALWAYS use tools before answering.
- NEVER answer project-related questions from general knowledge.
- Always gather information from the repository using tools.
- If unsure where to start, use search_code.

=====================
TOOL USAGE STRATEGY
=====================

- Use context tools (repo_tree, repo_summary, file_summary) for:
  - folder structure
  - project overview
  - summaries

- Use search tools (search_files, search_code) for:
  - finding implementations
  - locating functions, classes, or keywords
  - navigating large codebases

- Use filesystem tools (read_file, write_file, etc.) for:
  - reading full files after locating them
  - inspecting implementation details

- Use git tools (git_status, git_log, git_diff, etc.) ONLY for:
  - version control
  - commit history
  - repository changes

=====================
REASONING BEHAVIOR
=====================

- Break problems into steps.
- Use multiple tools if needed.
- Typical workflow:
  search_code → read_file → analyze → answer

- Do NOT stop after one tool if more information is needed.
- Combine results from multiple tools before answering.

=====================
SEARCH BEHAVIOR
=====================

- Prefer search_code before opening files blindly.
- After finding relevant files, use read_file for deeper understanding.
- Do not rely on a single match if multiple results exist.

=====================
PATH RULES (STRICT)
=====================

- ALL tool calls requiring "repo_path" MUST include it.
- Use:
  "." → for project root
  "workspace" → if user mentions workspace
  "apps/agent" → for subfolders

- NEVER use system paths like:
  "/", "/usr", "/etc", "/bin"

- Never omit repo_path.

=====================
FINAL ANSWERS
=====================

- Base answers ONLY on tool results.
- Be specific to the project.
- Reference actual implementation details when possible.

If no relevant information is found, say so instead of guessing.
`;

const MODEL_NAME = 'qwen2.5:1.5b';
const MAX_TOOL_ROUNDS = 6;

type ServerConfig = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
};

type ConnectedServer = {
  id: string;
  client: Client;
  transport: StdioClientTransport;
};

class MCPClient {
  private openai: OpenAI;
  private servers: ConnectedServer[] = [];
  private toolToServer = new Map<
    string,
    { client: Client; toolName: string; serverId: string }
  >();
  private tools: any[] = [];

  constructor() {
    this.openai = new OpenAI({
      baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1/',
      apiKey: 'ollama', // required but unused
    });
  }

  private registerServerTools(serverId: string, client: Client, tools: any[]) {
    for (const tool of tools) {
      if (this.toolToServer.has(tool.name)) {
        console.warn(
          `Skipping duplicate tool '${tool.name}' from '${serverId}'`,
        );
        continue;
      }

      this.toolToServer.set(tool.name, {
        client,
        toolName: tool.name,
        serverId,
      });

      this.tools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      });
    }
  }

  async connectToServers(serverConfigs: ServerConfig[]) {
    for (const config of serverConfigs) {
      const client = new Client({
        name: `mcp-client-cli-${config.id}`,
        version: '1.0.0',
      });
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
      });

      try {
        await client.connect(transport);
        const toolsResult = await client.listTools();
        this.registerServerTools(config.id, client, toolsResult.tools);
        this.servers.push({ id: config.id, client, transport });

        console.log(
          `Connected to '${config.id}' with tools:`,
          toolsResult.tools.map((t) => t.name),
        );
      } catch (e) {
        console.error(`Failed to connect to MCP server '${config.id}':`, e);
        await client.close().catch(() => undefined);
      }
    }

    if (this.servers.length === 0) {
      throw new Error('No MCP servers could be connected');
    }
  }

  private toolResultToString(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          }
          if (item && typeof item === 'object' && 'text' in item) {
            const textValue = (item as { text?: unknown }).text;
            return typeof textValue === 'string'
              ? textValue
              : JSON.stringify(item);
          }
          return JSON.stringify(item);
        })
        .join('\n');
    }
    return JSON.stringify(content);
  }

  async processQuery(query: string) {
    const messages: any[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: query },
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.openai.chat.completions.create({
        model: MODEL_NAME,
        messages,
        tools: this.tools,
      });

      const message = response?.choices[0]?.message;
      if (!message) throw new Error('No response from model');

      messages.push(message);

      // CASE 1: Final answer
      if (!message.tool_calls || message.tool_calls.length === 0) {
        return message.content ?? 'No response generated.';
      }

      // CASE 2: Tool usage
      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== 'function') continue;

        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);

        const targetTool = this.toolToServer.get(toolName);
        if (!targetTool) {
          throw new Error(`No MCP server registered for tool '${toolName}'`);
        }

        const result = await targetTool.client.callTool({
          name: targetTool.toolName,
          arguments: toolArgs,
        });

        const toolResult = this.toolResultToString(result.content);

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: `Tool: ${toolName}\nResult:\n${toolResult}`,
        });
      }

      messages.push({
        role: 'system',
        content:
          'Continue reasoning. Use more tools if needed. If the task is complete, provide the final answer.',
      });
    }

    return 'Max tool rounds reached without final answer.';
  }

  async chatLoop() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log('\nMCP Client Started!');
      console.log("Type your queries or 'quit' to exit.");

      while (true) {
        const message = await rl.question('\nQuery: ');

        if (message.toLowerCase() === 'quit') break;

        const response = await this.processQuery(message);
        console.log('\n' + response);
      }
    } finally {
      rl.close();
    }
  }

  async cleanup() {
    await Promise.all(this.servers.map((server) => server.client.close()));
  }
}

async function main() {
  const repoRoot = path.resolve(process.cwd(), '../..');
  const coreCwd = process.env.MCP_CORE_CWD ?? '../../mcp-servers/core';
  const filesystemRoot = process.env.MCP_FILESYSTEM_ROOT ?? repoRoot;
  const gitRepo = process.env.MCP_GIT_REPO ?? repoRoot;

  const serverConfigs: ServerConfig[] = [
    {
      id: 'filesystem',
      command: 'uv',
      args: ['run', 'python', 'filesystem.py', filesystemRoot],
      cwd: coreCwd,
    },
    {
      id: 'git',
      command: 'uv',
      args: ['run', 'python', 'gitTools.py', gitRepo],
      cwd: coreCwd,
    },
    {
      id: 'context',
      command: 'uv',
      args: ['run', 'python', 'context.py', gitRepo],
      cwd: coreCwd,
    },
  ];

  const mcpClient = new MCPClient();

  try {
    await mcpClient.connectToServers(serverConfigs);
    await mcpClient.chatLoop();
  } catch (e) {
    console.error('Error:', e);
    await mcpClient.cleanup();
    process.exit(1);
  } finally {
    await mcpClient.cleanup();
    process.exit(0);
  }
}

main();
