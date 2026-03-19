/**
 * Agent Logger - Structured Logging System
 * 
 * Provides structured logging for all agent decisions and actions.
 * Logging is controlled by DEBUG environment variable (DEBUG=1 to enable).
 */

import type {
  QueryClassification,
  AgentDecision,
  ToolCall,
  ToolResult,
  PhaseProgress,
} from './types';

/**
 * Check if debug mode is enabled
 */
function isDebugEnabled(): boolean {
  return process.env.DEBUG === '1' || process.env.DEBUG === 'true';
}

/**
 * Helper to format JSON for console output
 */
function formatJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

/**
 * Log query classification
 */
export function logQueryClassification(
  query: string,
  classification: QueryClassification
): void {
  if (!isDebugEnabled()) return;

  console.log('[CLASSIFICATION]', {
    query: query.substring(0, 80), // Truncate long queries
    type: classification.type,
    confidence: classification.confidence.toFixed(2),
    markers: {
      strong: classification.detectedMarkers.strong,
      weak: classification.detectedMarkers.weak,
      actionPatterns: classification.detectedMarkers.actionPatterns,
    },
    toolChain: classification.toolChain,
    reason: classification.reason,
  });
}

/**
 * Log when phase starts/ends
 */
export function logPhaseProgress(progress: PhaseProgress): void {
  if (!isDebugEnabled()) return;

  const details = {
    phase: progress.phase,
    status: progress.status,
    ...(progress.round && { round: progress.round }),
    ...(progress.toolsCalled && { toolsCalled: progress.toolsCalled }),
    ...(progress.confidence !== undefined && {
      confidence: progress.confidence.toFixed(2),
    }),
    ...(progress.details && { details: progress.details }),
  };

  console.log(`[PHASE_${progress.phase.toUpperCase()}]`, progress.status, details);
}

/**
 * Log tool call execution
 */
export function logToolCall(
  toolName: string,
  args: Record<string, unknown>,
  serverId: string
): void {
  if (!isDebugEnabled()) return;

  console.log(`[TOOL_CALL] ${toolName}`, {
    serverId,
    arguments: args,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Log tool result
 */
export function logToolResult(result: ToolResult): void {
  if (!isDebugEnabled()) return;

  const preview = result.content.substring(0, 150);
  const truncated = result.content.length > 150 ? '...' : '';

  console.log(`[TOOL_RESULT] ${result.toolCall.name}`, {
    success: result.success,
    resultSize: result.resultSize,
    durationMs: result.duration,
    preview: preview + truncated,
  });
}

/**
 * Log agent decision at each round
 */
export function logAgentDecision(decision: AgentDecision): void {
  if (!isDebugEnabled()) return;

  console.log(`[DECISION_R${decision.round}]`, {
    round: decision.round,
    decided: decision.decided,
    toolsToCall: decision.toolsToCall,
    reasoning: decision.reasoning,
    ...(decision.modelConfidence !== undefined && {
      modelConfidence: decision.modelConfidence.toFixed(2),
    }),
    timestamp: new Date(decision.timestamp).toISOString(),
  });
}

/**
 * Log error conditions
 */
export function logError(message: string, error?: unknown): void {
  console.error(`[ERROR] ${message}`, error || '');
}

/**
 * Log warnings
 */
export function logWarning(message: string, details?: unknown): void {
  console.warn(`[WARNING] ${message}`, details || '');
}

/**
 * Log info (always shown)
 */
export function logInfo(message: string, details?: unknown): void {
  console.log(`[INFO] ${message}`, details || '');
}

/**
 * Log phase forcing (when agent tries to exit early)
 */
export function logPhaseForcedContinue(reason: string, round: number): void {
  if (!isDebugEnabled()) return;

  console.log(`[FORCE_CONTINUE_R${round}]`, {
    reason,
    action: 'Forcing agent to continue Phase 1 research',
    timestamp: new Date().toISOString(),
  });
}

/**
 * Log phase transition (Phase 1 → Phase 2)
 */
export function logPhaseTransition(
  fromPhase: string,
  toPhase: string,
  details: Record<string, unknown>
): void {
  if (!isDebugEnabled()) return;

  console.log(`[PHASE_TRANSITION]`, {
    from: fromPhase,
    to: toPhase,
    ...details,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Log execution summary at end
 */
export function logExecutionSummary(
  query: string,
  isCodebaseQuery: boolean,
  toolsCalled: string[],
  totalRounds: number,
  durationMs: number
): void {
  if (!isDebugEnabled()) return;

  console.log('[EXECUTION_SUMMARY]', {
    query: query.substring(0, 80),
    queryType: isCodebaseQuery ? 'codebase' : 'general',
    toolsUsed: toolsCalled,
    totalToolCount: toolsCalled.length,
    roundsUsed: totalRounds,
    durationMs,
    timestamp: new Date().toISOString(),
  });
}
