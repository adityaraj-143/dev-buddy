/**
 * Phase 1 Validator - Validates research phase completion
 * 
 * Determines if the agent has gathered sufficient information
 * to move from Phase 1 (Research) to Phase 2 (Analysis).
 */

import type { Message, ResearchPhaseResult } from './types';

/**
 * Extract all tool calls from message history
 */
function extractToolCalls(messages: Message[]): string[] {
  const toolCalls: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const call of msg.tool_calls as any) {
        toolCalls.push(call.function.name);
      }
    }
  }

  return toolCalls;
}

/**
 * Extract tool results from message history
 */
function extractToolResults(messages: Message[]): Array<{ name: string; content: string }> {
  const results: Array<{ name: string; content: string }> = [];

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.content) {
      // Tool result format: "Tool: tool_name\nResult:\n{content}"
      const content = msg.content;
      const match = content.match(/Tool: (.+?)\nResult:\n([\s\S]*)/);
      if (match) {
        results.push({
          name: match[1] || '',
          content: match[2] || '',
        });
      }
    }
  }

  return results;
}

/**
 * Calculate information quality score based on results
 * 
 * More generous scoring to avoid getting stuck in Phase 1
 */
function calculateInformationQuality(results: Array<{ name: string; content: string }>): number {
  if (results.length === 0) return 0;

  let qualityScore = 0;

  for (const result of results) {
    const contentLength = result.content.length;

    // More generous scoring per result
    if (contentLength > 500) qualityScore += 0.5;    // Very detailed result
    else if (contentLength > 200) qualityScore += 0.4; // Good result
    else if (contentLength > 100) qualityScore += 0.3; // Decent result
    else if (contentLength > 50) qualityScore += 0.2;  // Minimal result
    else if (contentLength > 0) qualityScore += 0.1;   // Very minimal
  }

  // Base score on number of results + individual quality
  // Multiple results with even modest info = good progress
  const baseScore = Math.min(results.length * 0.2, 0.4); // Up to 0.4 from quantity
  const qualityPerResult = qualityScore / results.length;
  
  // Combined: benefits from both quantity and quality
  return Math.min(baseScore + qualityPerResult, 1);
}

/**
 * Calculate tool diversity bonus
 * Different tools → more thorough investigation
 */
function calculateToolDiversity(toolCalls: string[]): number {
  if (toolCalls.length === 0) return 0;

  const uniqueTools = new Set(toolCalls);
  const diversity = uniqueTools.size / toolCalls.length;

  // Diversity bonus: if using different tools, confidence increases
  return Math.min(diversity * 0.3, 0.3);
}

/**
 * Calculate confidence score for Phase 1 completion
 * 
 * Formula:
 * - Base: information quality (0-1)
 * - Bonus: tool diversity (0-0.3)
 * - Requirement: at least 1 tool result
 */
function calculateConfidence(
  toolCalls: string[],
  results: Array<{ name: string; content: string }>
): number {
  if (results.length === 0) return 0;

  const infoQuality = calculateInformationQuality(results);
  const diversity = calculateToolDiversity(toolCalls);

  // Combined confidence: quality + diversity bonus
  const confidence = Math.min(infoQuality + diversity, 1);

  return confidence;
}

/**
 * Validate Phase 1 completion
 * 
 * Phase 1 is considered complete if:
 * 1. At least 2 different tools called, OR confidence >= 0.6
 * 2. At least 1 non-empty result received
 */
export function validatePhase1Completion(
  messages: Message[],
  config?: { minTools?: number; confidenceThreshold?: number }
): ResearchPhaseResult {
  const minTools = config?.minTools ?? 2;
  const confidenceThreshold = config?.confidenceThreshold ?? 0.6;

  const toolCalls = extractToolCalls(messages);
  const results = extractToolResults(messages);

  const uniqueTools = new Set(toolCalls).size;
  const confidence = calculateConfidence(toolCalls, results);

  // Completion logic: (2+ tools) OR (confident result)
  const hasEnoughTools = uniqueTools >= minTools;
  const hasHighConfidence = confidence >= confidenceThreshold;
  const isComplete = hasEnoughTools || (hasHighConfidence && results.length > 0);

  // Build information map
  const foundInformation: Record<string, unknown> = {
    toolsExecuted: Array.from(new Set(toolCalls)),
    uniqueToolCount: uniqueTools,
    totalToolCalls: toolCalls.length,
    resultCount: results.length,
    hasResults: results.length > 0,
  };

  // Add content summaries
  for (const result of results) {
    foundInformation[`${result.name}_content`] = result.content.substring(0, 200);
  }

  // Determine reason
  let reason = '';
  if (isComplete) {
    if (hasEnoughTools) {
      reason = `Sufficient tools executed (${uniqueTools} >= ${minTools})`;
    } else {
      reason = `High confidence result (${confidence.toFixed(2)} >= ${confidenceThreshold})`;
    }
  } else {
    reason = `Need more research: ${uniqueTools}/${minTools} tools, confidence ${confidence.toFixed(2)} < ${confidenceThreshold}`;
  }

  return {
    executedTools: toolCalls.map((name) => ({
      id: name,
      name,
      arguments: {},
      serverId: 'unknown',
      timestamp: Date.now(),
    })),
    foundInformation,
    isComplete,
    confidence,
    reason,
  };
}

/**
 * Suggest next tool to call based on what's been gathered
 * 
 * Used when Phase 1 is incomplete to guide the agent
 */
export function suggestNextTool(
  messages: Message[],
  availableTools: string[]
): { suggestion: string; reasoning: string } {
  const toolCalls = extractToolCalls(messages);
  const calledTools = new Set(toolCalls);

  // Suggest tools in priority order
  const priorityTools = [
    'search_code',
    'file_summary',
    'repo_summary',
    'repo_tree',
    'git_log',
    'git_show',
  ];

  for (const tool of priorityTools) {
    if (availableTools.includes(tool) && !calledTools.has(tool)) {
      return {
        suggestion: tool,
        reasoning: `Try ${tool} to gather more specific information`,
      };
    }
  }

  // Fallback: suggest any unused tool
  for (const tool of availableTools) {
    if (!calledTools.has(tool)) {
      return {
        suggestion: tool,
        reasoning: `Try ${tool} for more context`,
      };
    }
  }

  return {
    suggestion: 'continue',
    reasoning: 'All available tools have been used',
  };
}

/**
 * Check if agent is trying to exit Phase 1 too early
 * 
 * Returns true if agent is providing an answer without completing Phase 1
 */
export function isEarlyExit(
  messages: Message[],
  config?: { minTools?: number; confidenceThreshold?: number }
): boolean {
  const phase1 = validatePhase1Completion(messages, config);
  return !phase1.isComplete;
}

/**
 * Get completion percentage for Phase 1
 */
export function getPhase1CompletionPercentage(
  messages: Message[],
  config?: { minTools?: number; confidenceThreshold?: number }
): number {
  const minTools = config?.minTools ?? 2;
  const phase1 = validatePhase1Completion(messages, config);

  const toolProgress = Math.min(
    new Set(extractToolCalls(messages)).size / minTools,
    1
  );
  const confidenceProgress = phase1.confidence;

  // Average of tool progress and confidence progress
  return (toolProgress + confidenceProgress) / 2;
}
