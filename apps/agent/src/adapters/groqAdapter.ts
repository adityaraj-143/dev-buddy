/**
 * Groq API Adapter
 * 
 * Groq uses OpenAI-compatible API, so minimal adaptation needed.
 * Just wraps the API client and passes through messages.
 */

import OpenAI from 'openai';
import type { Message } from '../core/types';

export class GroqAdapter {
  private client: OpenAI;
  private systemPrompt: string;
  private toolCallFailureCount = 0;

  constructor(apiKey: string, systemPrompt: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
    this.systemPrompt = systemPrompt;
  }

  /**
   * Prioritize and filter tools to send to the model
   * Groq models work best with a focused set of tools
   */
  private prioritizeTools(allTools: any[], maxTools: number = 10): any[] {
    if (!allTools || allTools.length === 0) return [];
    if (allTools.length <= maxTools) return allTools;

    // Priority order for code analysis tools
    const priorityOrder = [
      'find_files',      // Glob-based file finder (most important for file queries)
      'file_summary',    // Read file contents
      'search_code',     // Search code patterns
      'search_files',    // Search file contents (renamed from content search)
      'repo_summary',    // Repo overview
      'repo_tree',       // Directory structure
      'git_log',         // Git history
      'git_diff',        // Git changes
      'git_show',        // Git commit details
      'git_status',      // Git status
    ];

    const prioritized: any[] = [];
    const remaining: any[] = [];

    // First, add high-priority tools
    for (const priorityName of priorityOrder) {
      const tool = allTools.find((t: any) => t.function?.name === priorityName);
      if (tool && prioritized.length < maxTools) {
        prioritized.push(tool);
      }
    }

    // Fill remaining slots with other tools
    for (const tool of allTools) {
      if (!prioritized.find((t: any) => t.function?.name === tool.function?.name)) {
        if (prioritized.length < maxTools) {
          prioritized.push(tool);
        }
      }
    }

    return prioritized;
  }

  /**
   * Call Groq API with OpenAI-compatible interface
   */
  async createMessage(
    messages: Message[],
    tools: any[],
    modelName: string
  ): Promise<Message> {
    // Convert messages to OpenAI format, preserving tool_call_id
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'tool') {
        // Tool messages must include tool_call_id
        openaiMessages.push({
          role: 'tool',
          tool_call_id: msg.tool_call_id || '',
          content: msg.content || '',
        });
      } else if (msg.role === 'assistant') {
        // Include tool_calls if present
        const assistantMsg: any = {
          role: 'assistant',
          content: msg.content || '',
        };
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          assistantMsg.tool_calls = msg.tool_calls;
        }
        openaiMessages.push(assistantMsg);
      } else if (msg.role === 'system') {
        // Only add system message if this is the first one
        if (openaiMessages.length === 0) {
          openaiMessages.push({
            role: 'system',
            content: msg.content || '',
          });
        }
      } else {
        openaiMessages.push({
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content || '',
        });
      }
    }

    // Limit tools sent to Groq - use prioritized subset for better performance
    const toolsToSend = this.prioritizeTools(tools, 10);

    try {
      // Call Groq API with tool_choice='auto' to ensure tool calling is enabled
      const response = await this.client.chat.completions.create({
        model: modelName,
        max_tokens: 4096,
        messages: openaiMessages,
        tools: toolsToSend.length > 0 ? toolsToSend : undefined,
        tool_choice: toolsToSend.length > 0 ? 'auto' : undefined,
      } as any);

      // Convert response back to Message format
      const choice = response.choices[0];
      if (!choice) {
        throw new Error('No response from Groq API');
      }

      const message: Message = {
        role: 'assistant',
        content: choice.message.content || '',
        tool_calls: choice.message.tool_calls ? choice.message.tool_calls.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })) : undefined,
      };

      return message;
    } catch (error: any) {
      // Log detailed error information
      console.error('[GROQ_ADAPTER] Error calling Groq API:');
      console.error('Error type:', error?.constructor?.name);
      console.error('Error message:', error?.message);
      console.error('Error code:', error?.error?.code);
      console.error('Error status:', error?.status);
      console.error('Full error:', JSON.stringify(error, null, 2));
      
      // If tool calling fails, retry without tools
      if (error?.error?.code === 'tool_use_failed' && toolsToSend) {
        this.toolCallFailureCount++;
        console.log(`[GROQ_ADAPTER] Tool calling failed, retrying without tool constraints (attempt ${this.toolCallFailureCount})`);
        
        // Retry without forcing tool choice
        const response = await this.client.chat.completions.create({
          model: modelName,
          max_tokens: 4096,
          messages: openaiMessages,
          // Don't send tools on retry - let the model just generate text
        } as any);

        const choice = response.choices[0];
        if (!choice) {
          throw new Error('No response from Groq API');
        }

        return {
          role: 'assistant',
          content: choice.message.content || 'Unable to generate response',
        };
      }

      // Re-throw if not a tool calling error
      throw error;
    }
  }
}
