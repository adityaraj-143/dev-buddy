import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import readline from 'readline/promises';
import dotenv from 'dotenv';
import path from 'path';

import { loadConfig, validateConfig } from './agentConfig';
import { GroqAdapter } from './groqAdapter';
import { getFileResolutionContext, findRepoRoot } from './filePathResolver';
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

const SYSTEM_PROMPT = `You are a helpful assistant with access to tools for analyzing code in a local repository.

When users ask about files or code, use the available tools to find and analyze them.

IMPORTANT: When asked about specific files (like "context.py"):
1. Use search_files to find the file
2. Use file_summary to read the file
3. Provide analysis based on what you find

Available tools: search_files, search_code, file_summary, repo_tree, repo_summary, git_log, git_status, git_diff

Always base your answers on actual information from the tools, not assumptions.
`;

const MODEL_NAME = 'qwen2.5:1.5b';

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
  private groqAdapter: GroqAdapter;
  private servers: ConnectedServer[] = [];
  private toolToServer = new Map<
    string,
    { client: Client; toolName: string; serverId: string }
  >();
  private tools: any[] = [];
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    this.groqAdapter = new GroqAdapter(config.apiKey || '', SYSTEM_PROMPT);
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

  /**
   * Resolve file paths in tool arguments using the filePathResolver
   * This ensures that relative file paths like "context.py" get resolved to absolute paths
   */
  private resolveFilePathsInArgs(toolName: string, args: Record<string, any>): Record<string, any> {
    // Only process file_summary and search_files tools
    if (!['file_summary', 'search_files', 'search-files'].includes(toolName)) {
      return args;
    }

    const repoRoot = findRepoRoot();
    const resolvedArgs = { ...args };

    // Try to resolve file_path argument
    if ('file_path' in resolvedArgs && typeof resolvedArgs.file_path === 'string') {
      const filePath = resolvedArgs.file_path;
      
      // Only resolve if it looks like a relative path without full context
      if (!filePath.startsWith('/') && !filePath.startsWith('.') && 
          (filePath.includes('.') || filePath.length < 30)) {
        const resolution = getFileResolutionContext(filePath, repoRoot);
        if (resolution) {
          resolvedArgs.file_path = resolution.filePath;
          logInfo(`Resolved file path: "${filePath}" → "${resolution.filePath}"`);
        }
      }
    }

    return resolvedArgs;
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
      let phase1ForcedContinues = 0;
      for (let round = 0; round < this.config.maxTotalRounds; round++) {
        lastRound = round;
        // Call LLM via Groq adapter
        const message = await this.groqAdapter.createMessage(
          messages,
          this.tools,
          this.config.modelName
        );

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
              phase1ForcedContinues++;
              logPhaseForcedContinue(
                `Agent attempted early exit from Phase 1 (attempt ${phase1ForcedContinues})`,
                round
              );

              // After 3 forced continues, let agent answer anyway (fallback)
              if (phase1ForcedContinues >= 3) {
                logInfo(
                  `Phase 1 forced continues exceeded threshold. Allowing answer with current research.`
                );
                phase1Complete = true;
              } else {
                messages.push({
                  role: 'system',
                  content: `You must continue researching. You haven't yet gathered enough information about the codebase.

Current status: ${toolsCalled.length}/${this.config.phase1MinTools} tools used, ${phase1ForcedContinues}/3 continue warnings.

Use these research tools:
${classification.toolChain.slice(0, 3).join(', ')}

Do NOT provide a final answer until you've thoroughly investigated the codebase.`,
                });
                continue;
              }
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

          // Resolve file paths in tool arguments before execution
          const resolvedArgs = this.resolveFilePathsInArgs(toolName, toolArgs);

          try {
            const result = await targetTool.client.callTool({
              name: targetTool.toolName,
              arguments: resolvedArgs,
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
      const finalMessage = await this.groqAdapter.createMessage(
        messages,
        this.tools,
        this.config.modelName
      );
      
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
    // Disabled: Use search.py instead for better search_files tool
    // {
    //   id: 'filesystem',
    //   command: 'uv',
    //   args: ['run', 'python', 'filesystem.py', filesystemRoot],
    //   cwd: coreCwd,
    // },
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
