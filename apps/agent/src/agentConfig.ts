/**
 * Agent Configuration System
 * 
 * Manages agent behavior configuration with sensible defaults
 * and support for environment variable overrides.
 */

import type { AgentConfig } from './types';

/**
 * Default configuration for the agent
 */
export const DEFAULT_CONFIG: AgentConfig = {
  // Tool behavior
  enableForcedResearch: true,
  phase1MinTools: 2,
  phase1MaxRounds: 4,
  phase1ConfidenceThreshold: 0.6, // Flexible: can exit with 0.6+ confidence

  // Classification
  useStrictClassification: true,
  codebaseQueryConfidenceThreshold: 0.7,

  // Visibility
  debugLogging: false, // Controlled by DEBUG env var
  traceToolCalls: true,

  // Model behavior
  maxTotalRounds: 10,
  modelName: 'qwen2.5:1.5b',
  ollamaBaseUrl: 'http://localhost:11434/v1/',

  // Server configuration
  searchServerEnabled: true,
  gitServerEnabled: true,
  contextServerEnabled: true,
};

/**
 * Load configuration from environment and merge with defaults
 */
export function loadConfig(): AgentConfig {
  const config = { ...DEFAULT_CONFIG };

  // Debug logging controlled by DEBUG environment variable
  config.debugLogging = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

  // Override from environment variables
  if (process.env.AGENT_PHASE1_MIN_TOOLS) {
    config.phase1MinTools = parseInt(process.env.AGENT_PHASE1_MIN_TOOLS, 10);
  }

  if (process.env.AGENT_PHASE1_CONFIDENCE_THRESHOLD) {
    config.phase1ConfidenceThreshold = parseFloat(
      process.env.AGENT_PHASE1_CONFIDENCE_THRESHOLD
    );
  }

  if (process.env.AGENT_MAX_ROUNDS) {
    config.maxTotalRounds = parseInt(process.env.AGENT_MAX_ROUNDS, 10);
  }

  if (process.env.AGENT_MODEL_NAME) {
    config.modelName = process.env.AGENT_MODEL_NAME;
  }

  if (process.env.OLLAMA_BASE_URL) {
    config.ollamaBaseUrl = process.env.OLLAMA_BASE_URL;
  }

  // Server enable/disable flags
  if (process.env.AGENT_SEARCH_SERVER_ENABLED === 'false') {
    config.searchServerEnabled = false;
  }
  if (process.env.AGENT_GIT_SERVER_ENABLED === 'false') {
    config.gitServerEnabled = false;
  }
  if (process.env.AGENT_CONTEXT_SERVER_ENABLED === 'false') {
    config.contextServerEnabled = false;
  }

  return config;
}

/**
 * Validate configuration for consistency
 */
export function validateConfig(config: AgentConfig): string[] {
  const errors: string[] = [];

  if (config.phase1MinTools < 1) {
    errors.push('phase1MinTools must be >= 1');
  }

  if (config.phase1ConfidenceThreshold < 0 || config.phase1ConfidenceThreshold > 1) {
    errors.push('phase1ConfidenceThreshold must be between 0 and 1');
  }

  if (config.codebaseQueryConfidenceThreshold < 0 || config.codebaseQueryConfidenceThreshold > 1) {
    errors.push('codebaseQueryConfidenceThreshold must be between 0 and 1');
  }

  if (config.maxTotalRounds < 1) {
    errors.push('maxTotalRounds must be >= 1');
  }

  if (config.phase1MaxRounds > config.maxTotalRounds) {
    errors.push('phase1MaxRounds must be <= maxTotalRounds');
  }

  if (!config.modelName || config.modelName.trim() === '') {
    errors.push('modelName must be specified');
  }

  if (!config.ollamaBaseUrl || config.ollamaBaseUrl.trim() === '') {
    errors.push('ollamaBaseUrl must be specified');
  }

  return errors;
}

/**
 * Log configuration for debugging
 */
export function logConfig(config: AgentConfig): void {
  console.log('[CONFIG]', JSON.stringify(config, null, 2));
}
