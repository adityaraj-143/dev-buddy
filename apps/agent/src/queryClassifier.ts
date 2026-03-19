/**
 * Query Classifier - Determines if a query is about the codebase or general knowledge
 * 
 * Uses keyword patterns and context markers to classify queries with confidence scores.
 */

import type { QueryClassification, ClassificationMarkers } from './types';

/**
 * Keywords that indicate a codebase/project-specific query
 */
const CODEBASE_ACTION_PATTERNS = [
  'how does',
  'how do',
  'find',
  'where is',
  'where are',
  'show me',
  'search',
  'grep',
  'look for',
  'locate',
  'implement',
  'add',
  'create',
  'refactor',
  'fix',
  'debug',
  'what is the',
  'what are the',
  'explain',
  'understand',
  'what does',
];

/**
 * Strong context markers that indicate a codebase query
 */
const STRONG_CONTEXT_MARKERS = [
  'this project',
  'this codebase',
  'our codebase',
  'our project',
  'the repo',
  'the project',
  'the codebase',
  'in this project',
  'in the project',
  'in our codebase',
  'mcp',
  'agent',
  'server',
  'tool',
];

/**
 * Weak context markers (need other signals)
 */
const WEAK_CONTEXT_MARKERS = [
  'src/',
  'components/',
  'utils/',
  'lib/',
  'test/',
  'app.ts',
  'index.ts',
  '.py',
  '.ts',
  '.js',
  'function',
  'class',
  'module',
  'file',
  'repo',
  'code',
  'implementation',
  'codebase',
];

/**
 * Keywords indicating general/conceptual knowledge
 */
const GENERAL_KNOWLEDGE_PATTERNS = [
  'what is',
  'explain',
  'teach me',
  'how do promises work',
  'design pattern',
  'best practice',
  'concept',
  'definition',
];

/**
 * Extract markers from query text
 */
function extractMarkers(query: string): ClassificationMarkers {
  const lowerQuery = query.toLowerCase();

  const strong: string[] = [];
  const weak: string[] = [];
  const actionPatterns: string[] = [];

  // Check for strong markers
  for (const marker of STRONG_CONTEXT_MARKERS) {
    if (lowerQuery.includes(marker)) {
      strong.push(marker);
    }
  }

  // Check for weak markers
  for (const marker of WEAK_CONTEXT_MARKERS) {
    if (lowerQuery.includes(marker)) {
      weak.push(marker);
    }
  }

  // Check for action patterns
  for (const pattern of CODEBASE_ACTION_PATTERNS) {
    if (lowerQuery.includes(pattern)) {
      actionPatterns.push(pattern);
    }
  }

  return { strong, weak, actionPatterns };
}

/**
 * Calculate confidence score for codebase classification
 */
function calculateCodebaseConfidence(
  markers: ClassificationMarkers,
  hasGeneralPattern: boolean
): number {
  let confidence = 0;

  // Strong markers: +0.8 each (capped at 0.8)
  if (markers.strong.length > 0) {
    confidence = Math.min(0.8 + markers.strong.length * 0.05, 1.0);
  }
  // Weak markers with action pattern: +0.5-0.7
  else if (markers.weak.length > 0 && markers.actionPatterns.length > 0) {
    confidence = 0.5 + (markers.actionPatterns.length * 0.1 + markers.weak.length * 0.05);
    confidence = Math.min(confidence, 0.8);
  }
  // Action pattern alone: +0.4-0.6
  else if (markers.actionPatterns.length > 0) {
    confidence = 0.4 + markers.actionPatterns.length * 0.1;
    confidence = Math.min(confidence, 0.7);
  }
  // Weak markers alone: +0.3
  else if (markers.weak.length > 0) {
    confidence = 0.3;
  }

  // Reduce confidence if general knowledge pattern detected
  if (hasGeneralPattern) {
    confidence = Math.max(confidence - 0.2, 0);
  }

  return Math.min(Math.max(confidence, 0), 1);
}

/**
 * Determine if query contains general knowledge pattern
 */
function hasGeneralKnowledgePattern(query: string): boolean {
  const lowerQuery = query.toLowerCase();

  for (const pattern of GENERAL_KNOWLEDGE_PATTERNS) {
    if (lowerQuery.includes(pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Suggest tool chain based on query characteristics
 */
function suggestToolChain(
  markers: ClassificationMarkers,
  queryLower: string
): string[] {
  const tools: string[] = [];

  // If asking about structure/files
  if (
    queryLower.includes('file') ||
    queryLower.includes('folder') ||
    queryLower.includes('structure') ||
    queryLower.includes('directory')
  ) {
    tools.push('repo_tree', 'search_files', 'file_summary');
  }
  // If asking about implementation/code
  else if (
    queryLower.includes('implement') ||
    queryLower.includes('code') ||
    queryLower.includes('function') ||
    queryLower.includes('class')
  ) {
    tools.push('search_code', 'file_summary');
  }
  // If asking about git/history
  else if (
    queryLower.includes('commit') ||
    queryLower.includes('history') ||
    queryLower.includes('change') ||
    queryLower.includes('modified')
  ) {
    tools.push('git_log', 'git_diff', 'git_show');
  }
  // Default: start broad then narrow
  else {
    tools.push('repo_summary', 'search_code');
  }

  return tools;
}

/**
 * Classify a query as codebase or general knowledge
 */
export function classifyQuery(query: string): QueryClassification {
  if (!query || query.trim() === '') {
    return {
      type: 'general',
      confidence: 0,
      detectedMarkers: { strong: [], weak: [], actionPatterns: [] },
      toolChain: [],
      reason: 'Empty query',
    };
  }

  const markers = extractMarkers(query);
  const hasGeneral = hasGeneralKnowledgePattern(query);
  const codebaseConfidence = calculateCodebaseConfidence(markers, hasGeneral);

  // Determine type based on confidence threshold
  const isCodebaseQuery = codebaseConfidence >= 0.5; // 50% threshold for detection

  // Generate reason
  let reason = '';
  if (markers.strong.length > 0) {
    reason = `Strong codebase context detected: "${markers.strong[0]}"`;
  } else if (markers.actionPatterns.length > 0 && markers.weak.length > 0) {
    reason = `Project-specific query pattern with context markers`;
  } else if (markers.actionPatterns.length > 0) {
    reason = `Action pattern detected: "${markers.actionPatterns[0]}"`;
  } else if (hasGeneral) {
    reason = 'General knowledge question detected';
  } else {
    reason = 'Ambiguous query - classified based on confidence score';
  }

  const toolChain = isCodebaseQuery ? suggestToolChain(markers, query.toLowerCase()) : [];

  return {
    type: isCodebaseQuery ? 'codebase' : 'general',
    confidence: codebaseConfidence,
    detectedMarkers: markers,
    toolChain,
    reason,
  };
}

/**
 * Test the classifier on example queries
 */
export function testClassifier(): void {
  const testQueries = [
    'How does the agent loop work in this project?',
    'What is TypeScript?',
    'Find the MCP server implementation',
    'Explain design patterns',
    'How are git tools configured in our codebase?',
    'Where is the search function located?',
    'What is a promise?',
    'Show me the agent loop',
    'Tell me about this repo',
    'How do I use git?',
  ];

  console.log('[CLASSIFIER_TEST]');
  for (const query of testQueries) {
    const result = classifyQuery(query);
    console.log(`\nQuery: "${query}"`);
    console.log(
      `Result: ${result.type} (confidence: ${result.confidence.toFixed(2)}) - ${result.reason}`
    );
  }
}
