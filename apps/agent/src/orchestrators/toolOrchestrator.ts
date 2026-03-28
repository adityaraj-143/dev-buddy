/**
 * Tool Orchestrator - Intelligent tool selection and execution planning
 * 
 * Provides sophisticated logic for:
 * - Determining which tools to use for a given query
 * - Ordering tool execution for optimal results
 * - Preventing redundant tool calls
 * - Adapting strategy based on intermediate results
 */

import type { Message, QueryClassification } from '../core/types';

/**
 * Tool execution strategy - defines how tools should be used
 */
export interface ToolStrategy {
  primaryTools: string[];      // Must-use tools for this query type
  secondaryTools: string[];    // Optional tools for deeper investigation
  executionOrder: string[];    // Suggested order of execution
  reasoning: string;           // Why this strategy was chosen
  expectedRounds: number;      // How many tool rounds needed
}

/**
 * Tool execution context - tracks what's been done
 */
export interface ExecutionContext {
  toolsCalled: string[];
  messages: Message[];
  classification: QueryClassification;
  phase: 'research' | 'analysis';
}

/**
 * Tool usage patterns for different query types
 */
const TOOL_PATTERNS = {
  // Specific file mentioned (e.g., "show me context.py")
  specificFile: {
    primaryTools: ['find_files', 'file_summary'],
    secondaryTools: ['search_code', 'git_log'],
    reasoning: 'User mentioned specific file - locate then read it',
    expectedRounds: 2,
  },
  
  // Implementation query (e.g., "how does X work")
  implementation: {
    primaryTools: ['search_code', 'file_summary'],
    secondaryTools: ['find_files', 'repo_tree', 'git_log'],
    reasoning: 'Implementation question - search code then read files',
    expectedRounds: 3,
  },
  
  // Structure/organization query (e.g., "project structure")
  structure: {
    primaryTools: ['repo_summary', 'repo_tree'],
    secondaryTools: ['file_summary', 'find_files'],
    reasoning: 'Structural question - get overview and tree',
    expectedRounds: 2,
  },
  
  // Function/class lookup (e.g., "find function X")
  lookup: {
    primaryTools: ['search_code', 'file_summary'],
    secondaryTools: ['find_files'],
    reasoning: 'Code lookup - search for definition then read context',
    expectedRounds: 2,
  },
  
  // Historical query (e.g., "when was X changed")
  historical: {
    primaryTools: ['git_log', 'git_diff'],
    secondaryTools: ['file_summary'],
    reasoning: 'Historical question - check git history',
    expectedRounds: 2,
  },
  
  // Exploratory query (e.g., "tell me about this codebase")
  exploratory: {
    primaryTools: ['repo_summary', 'repo_tree', 'search_code'],
    secondaryTools: ['file_summary', 'git_log'],
    reasoning: 'Exploratory question - broad overview then specific investigation',
    expectedRounds: 4,
  },
  
  // General query (fallback)
  general: {
    primaryTools: ['repo_summary', 'search_code'],
    secondaryTools: ['file_summary', 'repo_tree'],
    reasoning: 'General question - overview then search',
    expectedRounds: 3,
  },
};

/**
 * Determine query intent from classification and extract entities
 */
export function analyzeQueryIntent(
  query: string,
  classification: QueryClassification
): {
  intent: keyof typeof TOOL_PATTERNS;
  entities: {
    files: string[];
    functions: string[];
    classes: string[];
    concepts: string[];
  };
} {
  const lowerQuery = query.toLowerCase();
  const entities = {
    files: extractFileNames(query),
    functions: extractFunctionNames(query),
    classes: extractClassNames(query),
    concepts: extractConcepts(query),
  };

  // Determine intent based on query patterns and entities
  
  // Specific file mentioned
  if (entities.files.length > 0) {
    return { intent: 'specificFile', entities };
  }

  // Historical questions
  if (
    lowerQuery.includes('when') ||
    lowerQuery.includes('history') ||
    lowerQuery.includes('commit') ||
    lowerQuery.includes('change')
  ) {
    return { intent: 'historical', entities };
  }

  // Structure questions
  if (
    lowerQuery.includes('structure') ||
    lowerQuery.includes('organization') ||
    lowerQuery.includes('layout') ||
    lowerQuery.includes('architecture')
  ) {
    return { intent: 'structure', entities };
  }

  // Function/class lookup
  if (
    (lowerQuery.includes('find') || lowerQuery.includes('where is')) &&
    (entities.functions.length > 0 || entities.classes.length > 0)
  ) {
    return { intent: 'lookup', entities };
  }

  // Implementation questions
  if (
    lowerQuery.includes('how does') ||
    lowerQuery.includes('how do') ||
    lowerQuery.includes('implement') ||
    lowerQuery.includes('work')
  ) {
    return { intent: 'implementation', entities };
  }

  // Exploratory questions
  if (
    lowerQuery.includes('tell me about') ||
    lowerQuery.includes('overview') ||
    lowerQuery.includes('what is this') ||
    lowerQuery.includes('explain this project')
  ) {
    return { intent: 'exploratory', entities };
  }

  // Default to general
  return { intent: 'general', entities };
}

/**
 * Extract file names from query
 */
function extractFileNames(query: string): string[] {
  const files: string[] = [];
  
  // Match common file extensions
  const filePattern = /\b[\w-]+\.(ts|js|py|java|cpp|c|h|tsx|jsx|go|rs|rb|php|html|css|json|yaml|yml|md|txt)\b/gi;
  const matches = query.match(filePattern);
  
  if (matches) {
    files.push(...matches);
  }

  // Match path-like patterns
  const pathPattern = /\b[\w-]+\/[\w-/.]+/g;
  const pathMatches = query.match(pathPattern);
  
  if (pathMatches) {
    files.push(...pathMatches);
  }

  return [...new Set(files)];
}

/**
 * Extract function names from query
 */
function extractFunctionNames(query: string): string[] {
  const functions: string[] = [];
  
  // Look for patterns like "function X", "the X function", etc.
  const patterns = [
    /function\s+(\w+)/gi,
    /the\s+(\w+)\s+function/gi,
    /(\w+)\s+function/gi,
    /(\w+)\(\)/g,
  ];

  for (const pattern of patterns) {
    const matches = query.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        functions.push(match[1]);
      }
    }
  }

  return [...new Set(functions)];
}

/**
 * Extract class names from query
 */
function extractClassNames(query: string): string[] {
  const classes: string[] = [];
  
  // Look for patterns like "class X", "the X class", etc.
  const patterns = [
    /class\s+(\w+)/gi,
    /the\s+(\w+)\s+class/gi,
    /(\w+)\s+class/gi,
  ];

  for (const pattern of patterns) {
    const matches = query.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        classes.push(match[1]);
      }
    }
  }

  return [...new Set(classes)];
}

/**
 * Extract key concepts from query
 */
function extractConcepts(query: string): string[] {
  const concepts: string[] = [];
  
  // Technical terms that might be important
  const technicalPatterns = [
    /\b(api|endpoint|route|handler|controller|service|repository|model|view|component)\b/gi,
    /\b(authentication|authorization|validation|middleware|database|cache|queue)\b/gi,
    /\b(test|testing|unit|integration|e2e)\b/gi,
  ];

  for (const pattern of technicalPatterns) {
    const matches = query.matchAll(pattern);
    for (const match of matches) {
      if (match[0]) {
        concepts.push(match[0].toLowerCase());
      }
    }
  }

  return [...new Set(concepts)];
}

/**
 * Generate tool execution strategy based on query analysis
 */
export function generateToolStrategy(
  query: string,
  classification: QueryClassification,
  availableTools: string[]
): ToolStrategy {
  const { intent, entities } = analyzeQueryIntent(query, classification);
  const pattern = TOOL_PATTERNS[intent];

  // Filter tools to only those available
  const primaryTools = pattern.primaryTools.filter(t => availableTools.includes(t));
  const secondaryTools = pattern.secondaryTools.filter(t => availableTools.includes(t));

  // Determine execution order based on intent
  let executionOrder: string[] = [];

  switch (intent) {
    case 'specificFile':
      // For specific files: search_files -> file_summary -> optionally search_code for related
      executionOrder = ['search_files', 'file_summary', 'search_code'];
      break;

    case 'implementation':
      // For implementation: search_code -> file_summary -> optionally repo_tree for context
      executionOrder = ['search_code', 'file_summary', 'repo_tree'];
      break;

    case 'structure':
      // For structure: repo_summary -> repo_tree -> optionally file_summary for key files
      executionOrder = ['repo_summary', 'repo_tree', 'file_summary'];
      break;

    case 'lookup':
      // For lookup: search_code -> file_summary
      executionOrder = ['search_code', 'file_summary'];
      break;

    case 'historical':
      // For historical: git_log -> git_diff -> optionally file_summary
      executionOrder = ['git_log', 'git_diff', 'file_summary'];
      break;

    case 'exploratory':
      // For exploratory: repo_summary -> repo_tree -> search_code -> file_summary
      executionOrder = ['repo_summary', 'repo_tree', 'search_code', 'file_summary'];
      break;

    default:
      // General: repo_summary -> search_code -> file_summary
      executionOrder = ['repo_summary', 'search_code', 'file_summary'];
  }

  // Filter execution order to only available tools
  executionOrder = executionOrder.filter(t => availableTools.includes(t));

  // Build reasoning string
  let reasoning = pattern.reasoning;
  if (entities.files.length > 0) {
    reasoning += ` | Files mentioned: ${entities.files.join(', ')}`;
  }
  if (entities.functions.length > 0) {
    reasoning += ` | Functions: ${entities.functions.join(', ')}`;
  }
  if (entities.classes.length > 0) {
    reasoning += ` | Classes: ${entities.classes.join(', ')}`;
  }

  return {
    primaryTools,
    secondaryTools,
    executionOrder,
    reasoning,
    expectedRounds: pattern.expectedRounds,
  };
}

/**
 * Suggest next tool to use based on execution context
 */
export function suggestNextTool(
  context: ExecutionContext,
  strategy: ToolStrategy,
  availableTools: string[]
): {
  tool: string;
  reasoning: string;
  priority: 'high' | 'medium' | 'low';
} {
  const calledTools = new Set(context.toolsCalled);

  // First, try to use primary tools in order
  for (const tool of strategy.primaryTools) {
    if (!calledTools.has(tool) && availableTools.includes(tool)) {
      return {
        tool,
        reasoning: `Primary tool for this query type - ${strategy.reasoning}`,
        priority: 'high',
      };
    }
  }

  // Next, follow the execution order
  for (const tool of strategy.executionOrder) {
    if (!calledTools.has(tool) && availableTools.includes(tool)) {
      return {
        tool,
        reasoning: `Next in optimal execution sequence`,
        priority: 'medium',
      };
    }
  }

  // Finally, try secondary tools
  for (const tool of strategy.secondaryTools) {
    if (!calledTools.has(tool) && availableTools.includes(tool)) {
      return {
        tool,
        reasoning: `Secondary tool for additional context`,
        priority: 'low',
      };
    }
  }

  // If all suggested tools used, pick any unused available tool
  for (const tool of availableTools) {
    if (!calledTools.has(tool)) {
      return {
        tool,
        reasoning: `Exploring additional available tools`,
        priority: 'low',
      };
    }
  }

  // Fallback
  return {
    tool: 'search_code',
    reasoning: 'Continuing investigation with code search',
    priority: 'low',
  };
}

/**
 * Detect if tools are being used redundantly
 */
export function detectRedundancy(context: ExecutionContext): {
  isRedundant: boolean;
  reason?: string;
} {
  const toolCounts = new Map<string, number>();
  
  for (const tool of context.toolsCalled) {
    toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
  }

  // Check if any tool was called more than twice
  for (const [tool, count] of toolCounts.entries()) {
    if (count > 2) {
      return {
        isRedundant: true,
        reason: `Tool '${tool}' called ${count} times - may be stuck in a loop`,
      };
    }
  }

  // Check if the same tool was called twice in a row recently
  if (context.toolsCalled.length >= 2) {
    const last = context.toolsCalled[context.toolsCalled.length - 1];
    const secondLast = context.toolsCalled[context.toolsCalled.length - 2];
    
    if (last === secondLast) {
      return {
        isRedundant: true,
        reason: `Tool '${last}' called twice consecutively - likely redundant`,
      };
    }
  }

  return { isRedundant: false };
}

/**
 * Evaluate if enough tools have been used for the query type
 */
export function evaluateToolCoverage(
  context: ExecutionContext,
  strategy: ToolStrategy
): {
  isSufficient: boolean;
  coverage: number; // 0-1
  missingCritical: string[];
} {
  const calledTools = new Set(context.toolsCalled);
  const uniqueToolsUsed = calledTools.size;

  // Check how many primary tools were used
  const primaryUsed = strategy.primaryTools.filter(t => calledTools.has(t));
  const primaryCoverage = strategy.primaryTools.length > 0
    ? primaryUsed.length / strategy.primaryTools.length
    : 1;

  // Missing critical tools
  const missingCritical = strategy.primaryTools.filter(t => !calledTools.has(t));

  // Overall coverage score
  const coverage = Math.min(
    (uniqueToolsUsed / strategy.expectedRounds) * 0.6 + primaryCoverage * 0.4,
    1
  );

  // Sufficient if:
  // - All primary tools used OR
  // - At least 2 unique tools used AND coverage >= 0.7
  const isSufficient = 
    missingCritical.length === 0 || 
    (uniqueToolsUsed >= 2 && coverage >= 0.7);

  return {
    isSufficient,
    coverage,
    missingCritical,
  };
}
