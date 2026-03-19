import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import readline from 'readline/promises';
import dotenv from 'dotenv';
import path from 'path';

import { loadConfig, validateConfig } from './agentConfig';
import {
  logQueryClassification,
  logPhaseProgress,
  logToolCall,
  logToolResult,
  logAgentDecision,
  logPhaseForcedContinue,
  logPhaseTransition,
  logExecutionSummary,
  logPhase1ValidationDetails,
  logError,
  logInfo,
} from './agentLogger';
import { classifyQuery } from './queryClassifier';
import { validatePhase1Completion, suggestNextTool, isEarlyExit } from './phaseValidator';
import type {
  AgentConfig,
  Message,
  OpenAIToolCall,
  ToolResult,
} from './types';

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
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    this.openai = new OpenAI({
      baseURL: config.ollamaBaseUrl,
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
    const startTime = Date.now();

    try {
      // STEP 0: Classify query
      const classification = classifyQuery(query);
      logQueryClassification(query, classification);

      const messages: Message[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: query },
      ];

      // STEP 1: Determine if this is a codebase query requiring Phase 1
      const isCodebaseQuery = classification.type === 'codebase';
      let phase1Complete = false;
      const toolsCalled: string[] = [];

      logPhaseProgress({
        phase: 'research',
        status: 'started',
        details: {
          isCodebaseQuery,
          requiredTools: classification.toolChain,
        },
      });

      // STEP 2: Main reasoning loop
      let lastRound = 0;
      for (let round = 0; round < this.config.maxTotalRounds; round++) {
        lastRound = round;
        // Call LLM
        const response = await this.openai.chat.completions.create({
          model: this.config.modelName,
          messages: messages as any,
          tools: this.tools,
        });

        const message = (response?.choices[0]?.message) as any;
        if (!message) throw new Error('No response from model');

        messages.push(message as Message);

        // STEP 3: Check if agent wants to stop
        if (!message.tool_calls || message.tool_calls.length === 0) {
          // Codebase query: check if Phase 1 is complete
          if (isCodebaseQuery && !phase1Complete) {
            const earlyExit = isEarlyExit(messages, {
              minTools: this.config.phase1MinTools,
              confidenceThreshold: this.config.phase1ConfidenceThreshold,
            });

            if (earlyExit) {
              logPhaseForcedContinue('Agent attempted early exit from Phase 1', round);

              messages.push({
                role: 'system',
                content: `You must continue researching. You haven't yet gathered enough information about the codebase.

Current status: ${toolsCalled.length}/${this.config.phase1MinTools} tools used.

Continue by calling one of these tools:
${classification.toolChain.slice(0, 3).join(', ')}

Do NOT provide a final answer until you've thoroughly investigated the codebase.`,
              });
              continue;
            }
          }

          // Exit is allowed
          const durationMs = Date.now() - startTime;
          logExecutionSummary(query, isCodebaseQuery, toolsCalled, round + 1, durationMs);
          return message.content ?? 'No response generated.';
        }

        // STEP 4: Execute tools
        for (const toolCall of message.tool_calls) {
          if (toolCall.type !== 'function') continue;

          // Cast to our custom interface which matches the OpenAI SDK structure
          const call = toolCall as unknown as OpenAIToolCall;
          const toolName = call.function.name;
          const toolArgs = JSON.parse(call.function.arguments);
          const callStartTime = Date.now();

          logToolCall(toolName, toolArgs, '?');

          const targetTool = this.toolToServer.get(toolName);
          if (!targetTool) {
            throw new Error(`No MCP server registered for tool '${toolName}'`);
          }

          try {
            const result = await targetTool.client.callTool({
              name: targetTool.toolName,
              arguments: toolArgs,
            });

            const toolResult = this.toolResultToString(result.content);
            const duration = Date.now() - callStartTime;

            logToolResult({
              toolCall: {
                id: toolCall.id,
                name: toolName,
                arguments: toolArgs,
                serverId: targetTool.serverId,
                timestamp: callStartTime,
              },
              content: toolResult,
              success: true,
              duration,
              resultSize: toolResult.length,
            });

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Tool: ${toolName}\nResult:\n${toolResult}`,
            });

            toolsCalled.push(toolName);
          } catch (error) {
            logError(`Tool ${toolName} failed`, error);

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Tool: ${toolName}\nResult:\nError: ${error instanceof Error ? error.message : 'Unknown error'}`,
            });
          }
        }

        // STEP 5: Validate Phase 1 completion if codebase query
        if (isCodebaseQuery && !phase1Complete) {
          const phase1Result = validatePhase1Completion(messages, {
            minTools: this.config.phase1MinTools,
            confidenceThreshold: this.config.phase1ConfidenceThreshold,
          });

          // Log detailed validation info
          logPhase1ValidationDetails({
            uniqueTools: new Set(toolsCalled).size,
            minToolsRequired: this.config.phase1MinTools,
            confidence: phase1Result.confidence,
            confidenceThreshold: this.config.phase1ConfidenceThreshold,
            resultCount: (phase1Result.foundInformation as any)?.resultCount || 0,
            reason: phase1Result.reason || '',
            isComplete: phase1Result.isComplete,
          });

          logPhaseProgress({
            phase: 'research',
            status: 'in_progress',
            round,
            toolsCalled: Array.from(new Set(toolsCalled)),
            confidence: phase1Result.confidence,
          });

          if (phase1Result.isComplete) {
            phase1Complete = true;

            logPhaseTransition('research', 'analysis', {
              toolsUsed: Array.from(new Set(toolsCalled)),
              confidence: phase1Result.confidence,
            });

            messages.push({
              role: 'system',
              content: `PHASE_1_RESEARCH_COMPLETE.

You have gathered sufficient information about the codebase. Now move to PHASE 2:
- Analyze your findings
- Provide a comprehensive answer grounded in the actual code
- Reference specific files and line numbers from what you discovered
- Base your answer entirely on what you found with the tools, not general knowledge

Provide the final answer now.`,
            });
          } else {
            // Still need more research
            const nextTool = suggestNextTool(messages, this.tools.map((t) => t.function.name));

            messages.push({
              role: 'system',
              content: `Continue Phase 1 research. You have gathered some information but need more.

Current progress: ${phase1Result.confidence.toFixed(2)} confidence
Tools used: ${Array.from(new Set(toolsCalled)).join(', ')}

Next step: Use ${nextTool.suggestion} to gather more details.
Reasoning: ${nextTool.reasoning}

Continue investigating.`,
            });
          }
        } else {
          // Non-codebase query or Phase 2 - normal continuation
          messages.push({
            role: 'system',
            content:
              'Continue reasoning. Use more tools if needed. If you have enough information, provide the final answer.',
          });
        }

        logAgentDecision({
          round,
          decided: phase1Complete ? 'provide_answer' : 'use_tools',
          toolsToCall: message.tool_calls ? message.tool_calls.map((t: any) => t.function.name) : [],
          reasoning: isCodebaseQuery
            ? `Phase 1: ${phase1Complete ? 'complete' : 'in progress'}`
            : 'General query',
          timestamp: Date.now(),
        });
      }

      const durationMs = Date.now() - startTime;
      logExecutionSummary(query, isCodebaseQuery, toolsCalled, lastRound + 1, durationMs);
      
      // Force answer after max rounds instead of giving up
      logInfo(`Max rounds reached (${lastRound + 1}/${this.config.maxTotalRounds}). Forcing final answer from agent.`);
      
      messages.push({
        role: 'system',
        content: `RESEARCH TIME LIMIT REACHED.

You have used ${toolsCalled.length} different tools and gathered information from ${lastRound + 1} rounds.

Based on your research so far, provide your best answer now. Even if you feel it's incomplete, 
give your analysis based on what you've gathered. Do not perform more tool calls.

Provide the final answer immediately.`,
      });
      
      // One more LLM call to force the answer
      const finalResponse = await this.openai.chat.completions.create({
        model: this.config.modelName,
        messages: messages as any,
        tools: this.tools,
      });
      
      const finalMessage = finalResponse?.choices[0]?.message;
      if (finalMessage) {
        logInfo(`Forced answer generated after ${lastRound + 1} rounds`);
        return finalMessage.content ?? 'Unable to generate final answer.';
      }
      
      return 'Max tool rounds reached without final answer.';
    } catch (error) {
      logError('Error processing query', error);
      throw error;
    }
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
    {
      id: 'search',
      command: 'uv',
      args: ['run', 'python', 'search.py', repoRoot],
      cwd: coreCwd,
    },
  ];

  // Load and validate configuration
  const config = loadConfig();
  validateConfig(config);

  const mcpClient = new MCPClient(config);

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
