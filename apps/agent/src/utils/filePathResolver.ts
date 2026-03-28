/**
 * File Path Resolver
 * 
 * Intelligently resolves partial file paths to absolute paths.
 * Helps when users ask about "types.ts" without knowing it's in "apps/agent/src/types.ts"
 */

import { readdirSync, statSync, existsSync } from 'fs';
import path from 'path';

/**
 * Auto-detect the repository root by looking for .git or package.json
 * Walks up the directory tree until it finds these indicators
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let currentDir = path.resolve(startDir);
  const root = path.parse(currentDir).root;

  // Walk up the directory tree
  while (currentDir !== root) {
    // Check for .git directory (most reliable indicator)
    if (existsSync(path.join(currentDir, '.git'))) {
      return currentDir;
    }

    // Check for package.json (fallback for non-git repos)
    if (existsSync(path.join(currentDir, 'package.json'))) {
      // Verify this is the root package.json, not a nested one
      const parent = path.dirname(currentDir);
      if (parent === root || !existsSync(path.join(parent, 'package.json'))) {
        return currentDir;
      }
    }

    // Move up one directory
    currentDir = path.dirname(currentDir);
  }

  // Fallback to current working directory
  return process.cwd();
}
export interface FileResolutionResult {
  found: boolean;
  matches: string[];
  suggestedPath?: string; // Most likely match
  reason: string;
}

/**
 * Recursively search for files matching a pattern
 */
function findFiles(
  dir: string,
  pattern: string,
  maxDepth: number = 10,
  currentDepth: number = 0,
  excludeDirs: Set<string> = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.opencode'])
): string[] {
  const matches: string[] = [];

  if (currentDepth > maxDepth) return matches;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (excludeDirs.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative('.', fullPath);

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        matches.push(...findFiles(fullPath, pattern, maxDepth, currentDepth + 1, excludeDirs));
      } else if (entry.isFile()) {
        // Check if file matches pattern
        if (matchesPattern(entry.name, pattern)) {
          matches.push(relativePath);
        }
      }
    }
  } catch (error) {
    // Permission denied or other fs error - silently continue
  }

  return matches;
}

/**
 * Match file name against pattern
 */
function matchesPattern(fileName: string, pattern: string): boolean {
  const lowerFileName = fileName.toLowerCase();
  const lowerPattern = pattern.toLowerCase();

  // Exact match
  if (lowerFileName === lowerPattern) return true;

  // Match with extensions
  if (lowerFileName === `${lowerPattern}.ts`) return true;
  if (lowerFileName === `${lowerPattern}.tsx`) return true;
  if (lowerFileName === `${lowerPattern}.js`) return true;
  if (lowerFileName === `${lowerPattern}.jsx`) return true;
  if (lowerFileName === `${lowerPattern}.py`) return true;
  if (lowerFileName === `${lowerPattern}.json`) return true;

  // Partial match for searches
  return lowerFileName.includes(lowerPattern);
}

/**
 * Resolve a partial file name to its absolute path
 * 
 * @param fileName - Partial file name (e.g., "types.ts", "agentConfig")
 * @param repoRoot - Repository root path (auto-detected if not provided)
 * @returns Resolution result with matches and best guess
 */
export function resolveFilePath(fileName: string, repoRoot?: string): FileResolutionResult {
  // Auto-detect repo root if not provided
  const rootDir = repoRoot || findRepoRoot();

  if (!fileName || fileName.trim() === '') {
    return {
      found: false,
      matches: [],
      reason: 'Empty file name provided',
    };
  }

  const cleanFileName = fileName.trim();

  // Search for exact matches first
  const exactMatches = findFiles(rootDir, cleanFileName, 8);

  if (exactMatches.length > 0) {
    // Sort by path depth (prefer shallower paths)
    const sortedMatches = exactMatches.sort((a: string, b: string) => {
      const depthA = a.split(path.sep).length;
      const depthB = b.split(path.sep).length;
      return depthA - depthB;
    });

    return {
      found: true,
      matches: sortedMatches,
      suggestedPath: sortedMatches[0],
      reason: `Found "${cleanFileName}" at: ${sortedMatches[0]}`,
    };
  }

  // If no exact match, return not found
  return {
    found: false,
    matches: [],
    reason: `File "${cleanFileName}" not found in repository`,
  };
}

/**
 * Extract potential file names from a query string
 * Looks for patterns like "types.ts", "filename", or ".ts files"
 */
export function extractFileNamesFromQuery(query: string): string[] {
  const fileNames: string[] = [];

  // Pattern 1: Explicit .ts/.js/.tsx/.jsx file names (e.g., "types.ts")
  const explicitFilePattern = /[\w.-]+\.(ts|tsx|js|jsx|py|json|yaml|yml)/gi;
  const explicitMatches = query.match(explicitFilePattern);
  if (explicitMatches) {
    fileNames.push(...explicitMatches.map((f: string) => f.toLowerCase()));
  }

  // Pattern 2: "explain X", "tell me about X", "show me X" where X is a word (camelCase or snake_case)
  const actionPatterns = /(?:explain|tell\s+me\s+about|show\s+me|find\s+the|find)\s+(\w+)/gi;
  let match: RegExpExecArray | null;
  while ((match = actionPatterns.exec(query)) !== null) {
    const term = match[1]!.toLowerCase();
    // Only add if it looks like a potential file/component name (contains letters)
    if (/[a-z]/i.test(term) && term.length > 2) {
      fileNames.push(term);
    }
  }

  // Pattern 3: Common code patterns (e.g., "the agentConfig file", "show me utils")
  const commonPatterns = /(?:the\s+|in\s+)(\w+)\s+(?:file|module|function|class)/gi;
  while ((match = commonPatterns.exec(query)) !== null) {
    fileNames.push(match[1]!.toLowerCase());
  }

  // Pattern 4: "in X file" pattern (e.g., "in types.ts file")
  const inFilePattern = /in\s+(\w+(?:\.\w+)?)\s+file/gi;
  while ((match = inFilePattern.exec(query)) !== null) {
    fileNames.push(match[1]!.toLowerCase());
  }

  return Array.from(new Set(fileNames)); // Remove duplicates
}

/**
 * Enhance file_summary tool arguments with resolved paths
 * 
 * @param fileName - File name or pattern from user
 * @param repoRoot - Repository root (auto-detected if not provided)
 * @returns Enhanced arguments for file_summary tool
 */
export function getFileResolutionContext(
  fileName: string,
  repoRoot?: string
): { filePath: string; alternatives?: string[]; fullPath: string } | null {
  const rootDir = repoRoot || findRepoRoot();
  const resolution = resolveFilePath(fileName, rootDir);

  if (!resolution.found || !resolution.suggestedPath) {
    return null;
  }

  return {
    filePath: resolution.suggestedPath,
    alternatives: resolution.matches.length > 1 
      ? resolution.matches.slice(1, 4) 
      : undefined,
    fullPath: path.resolve(rootDir, resolution.suggestedPath),
  };
}

/**
 * Test file resolution on example queries
 */
export function testFileResolution(repoRoot?: string): void {
  const rootDir = repoRoot || findRepoRoot();
  
  console.log(`[FILE_RESOLUTION_TEST] - Repo root detected: ${rootDir}\n`);
  
  const testQueries = [
    'explain me the code in types.ts file',
    'show me agentConfig.ts',
    'what is in the index file',
    'explain queryClassifier',
    'tell me about groqAdapter',
    'find the logger',
  ];

  console.log('[FILE_RESOLUTION_TEST]');
  for (const query of testQueries) {
    const fileNames = extractFileNamesFromQuery(query);
    console.log(`\nQuery: "${query}"`);
    console.log(`Extracted file names: ${fileNames.join(', ') || 'none'}`);

    for (const fileName of fileNames) {
      const resolution = resolveFilePath(fileName, rootDir);
      console.log(`  → "${fileName}": ${resolution.reason}`);
      if (resolution.suggestedPath) {
        console.log(`     Suggested path: ${resolution.suggestedPath}`);
      }
      if (resolution.matches.length > 1) {
        console.log(`     Other matches: ${resolution.matches.slice(1, 3).join(', ')}`);
      }
    }
  }
}
