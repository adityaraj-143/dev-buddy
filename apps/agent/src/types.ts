/**
 * Type definitions for Dev-Intel Agent
 * 
 * Defines all interfaces and types used throughout the agent system.
 */

/**
 * Configuration for the agent behavior
 */
export interface AgentConfig {
  // Tool behavior
  enableForcedResearch: boolean;
  phase1MinTools: number;
  phase1MaxRounds: number;
  phase1ConfidenceThreshold: number;

  // Classification
  useStrictClassification: boolean;
  codebaseQueryConfidenceThreshold: number;

  // Visibility
  debugLogging: boolean;
  traceToolCalls: boolean;

  // Model behavior
  maxTotalRounds: number;
  modelName: string;
  ollamaBaseUrl: string;
  apiKey?: string;

  // Server configuration
  searchServerEnabled: boolean;
  gitServerEnabled: boolean;
  contextServerEnabled: boolean;
}

/**
 * Markers detected in a query
 */
export interface ClassificationMarkers {
  strong: string[];
  weak: string[];
  actionPatterns: string[];
}

/**
 * Result of query classification
 */
export interface QueryClassification {
  type: 'codebase' | 'general';
  confidence: number; // 0-1
  detectedMarkers: ClassificationMarkers;
  toolChain: string[];
  reason: string;
}

/**
 * Information about tool execution
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  serverId: string;
  timestamp: number;
}

/**
 * Result of tool execution
 */
export interface ToolResult {
  toolCall: ToolCall;
  content: string;
  success: boolean;
  duration: number;
  resultSize: number;
}

/**
 * Agent decision at a particular round
 */
export interface AgentDecision {
  round: number;
  decided: 'use_tools' | 'provide_answer' | 'continue_phase1';
  toolsToCall: string[];
  reasoning: string;
  modelConfidence?: number;
  timestamp: number;
}

/**
 * Result of Phase 1 research validation
 */
export interface ResearchPhaseResult {
  executedTools: ToolCall[];
  foundInformation: Record<string, unknown>;
  isComplete: boolean;
  confidence: number; // 0-1, quality of gathered info
  reason?: string;
}

/**
 * OpenAI-format message
 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

/**
 * OpenAI function tool call
 */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/**
 * OpenAI function tool definition
 */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON schema
  };
}

/**
 * MCP server configuration
 */
export interface ServerConfig {
  id: string;
  command: string;
  args: string[];
  cwd: string;
}

/**
 * Connected MCP server
 */
export interface ConnectedServer {
  id: string;
  client: unknown; // MCP Client type
  transport: unknown; // StdioClientTransport type
}

/**
 * Tool registry entry
 */
export interface ToolRegistry {
  client: unknown; // MCP Client
  toolName: string;
  serverId: string;
}

/**
 * Phase progress information
 */
export interface PhaseProgress {
  phase: 'classification' | 'research' | 'analysis';
  status: 'started' | 'in_progress' | 'completed';
  round?: number;
  toolsCalled?: string[];
  confidence?: number;
  details?: Record<string, unknown>;
}

/**
 * Complete agent execution state
 */
export interface AgentExecutionState {
  query: string;
  classification: QueryClassification;
  isCodebaseQuery: boolean;
  phase1Complete: boolean;
  currentRound: number;
  messages: Message[];
  toolsCalled: ToolCall[];
  decisions: AgentDecision[];
  phaseProgress: PhaseProgress[];
  startTime: number;
  endTime?: number;
}

/**
 * Statistics about agent execution
 */
export interface ExecutionStats {
  totalRounds: number;
  toolRoundsUsed: number;
  toolsCalled: string[];
  totalToolCallCount: number;
  phase1ConfidenceScore: number;
  executionTimeMs: number;
  isCodebaseQuery: boolean;
  classificationConfidence: number;
}
