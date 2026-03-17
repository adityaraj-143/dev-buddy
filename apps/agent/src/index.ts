import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import readline from 'readline/promises';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const SYSTEM_PROMPT = `You are an MCP-powered coding assistant.

Tool selection rules:
- Use context tools (repo_tree, repo_summary, file_summary) for directory trees, repository summaries, file summaries, and understanding folder contents.
- Use filesystem tools (search-files, write-file, delete-file) for raw text search, file writes, and deletes.
- Use git tools (git_status, git_log, etc.) only for git repository operations.
- If the user asks to list a folder, inspect a folder, summarize a folder, or summarize files in a folder, prefer context tools first.
- Do not use search-files when the user is asking for directory structure or summaries unless they explicitly ask for text search.

Path rules (CRITICAL - always follow these):
- ALL tool calls that have a "repo_path" argument MUST include it. Never call a tool without repo_path if it is required.
- Relative paths are resolved from the dev-buddy project root.
- When the user mentions a folder name like "workspace", always pass repo_path as that exact folder name (e.g., repo_path: "workspace").
- When the user mentions a subfolder like "apps/agent", pass repo_path as "apps/agent".
- If the user says "this project", "project root", "root", "here", or "dev-buddy", pass repo_path as ".".
- NEVER pass repo_path as "/" or system paths like "/usr", "/bin", "/etc", "/sys". Those are blocked.
- Never omit repo_path or leave it empty.
- When the user asks to "use all the tools" from a server, call each relevant tool from that server and combine the results.
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
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: query,
      },
    ];

    let finalText = '';

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await this.openai.chat.completions.create({
        model: MODEL_NAME,
        messages,
        tools: this.tools,
      });

      const message = response?.choices[0]?.message;
      if (!message) {
        throw new Error('No response from model');
      }

      messages.push(message);

      if (message.content) {
        finalText += (finalText ? '\n' : '') + message.content;
      }

      if (!message.tool_calls?.length) {
        break;
      }

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

        finalText += `\n[Calling ${targetTool.serverId}.${toolName} with args ${JSON.stringify(toolArgs)}]`;

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: this.toolResultToString(result.content),
        });
      }
    }

    return finalText || 'No response generated.';
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
