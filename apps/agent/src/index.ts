import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import readline from 'readline/promises';
import dotenv from 'dotenv';

dotenv.config();

class MCPClient {
  private mcp: Client;
  private openai: OpenAI;
  private transport: StdioClientTransport | null = null;
  private tools: any[] = [];

  constructor() {
    this.openai = new OpenAI({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'ollama', // required but unused
    });

    this.mcp = new Client({ name: 'mcp-client-cli', version: '1.0.0' });
  }

  async connectToServer(serverScriptPath: string) {
    try {
      const isPy = serverScriptPath.endsWith('.py');
      if (!isPy) {
        throw new Error('Server script must be a .py file');
      }

      this.transport = new StdioClientTransport({
        command: 'uv',
        args: ['run', 'python', 'filesystem.py', '.'],
        cwd: '../../mcp-servers/core',
      });

      await this.mcp.connect(this.transport);

      const toolsResult = await this.mcp.listTools();

      this.tools = toolsResult.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));

      console.log(
        'Connected to server with tools:',
        this.tools.map((t) => t.function.name),
      );
    } catch (e) {
      console.log('Failed to connect to MCP server:', e);
      throw e;
    }
  }

  async processQuery(query: string) {
    const messages: any[] = [
      {
        role: 'user',
        content: query,
      },
    ];

    const response = await this.openai.chat.completions.create({
      model: 'qwen2.5', // ollama model
      messages,
      tools: this.tools,
    });

    const message = response?.choices[0]?.message;
    if (!message) {
      throw new Error('No response from model');
    }

    let finalText = message.content ?? '';

    if (message.tool_calls) {
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.type !== 'function') continue;

        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);
        const result = await this.mcp.callTool({
          name: toolName,
          arguments: toolArgs,
        });

        finalText += `\n[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`;

        messages.push(message);

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result.content as string,
        });

        const secondResponse = await this.openai.chat.completions.create({
          model: 'qwen2.5',
          messages,
        });

        const secondMessage = secondResponse.choices?.[0]?.message;

        if (secondMessage?.content) {
          finalText += '\n' + secondMessage.content;
        }
      }
    }

    return finalText;
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
    await this.mcp.close();
  }
}

async function main() {
  if (process.argv.length < 3) {
    console.log('Usage: bun run index.ts <path_to_server_script>');
    return;
  }

  const mcpClient = new MCPClient();

  try {
    await mcpClient.connectToServer(process.argv[2]!);
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
