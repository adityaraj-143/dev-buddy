/**
 * Groq API Adapter
 * 
 * Groq uses OpenAI-compatible API, so minimal adaptation needed.
 * Just wraps the API client and passes through messages.
 */

import OpenAI from 'openai';
import type { Message } from './types';

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

    // Limit tools sent to Groq - sometimes too many tools confuses the model
    const toolsToSend = tools && tools.length > 0 ? tools.slice(0, 8) : undefined;

    try {
      // Call Groq API with tool_choice='auto' to ensure tool calling is enabled
      const response = await this.client.chat.completions.create({
        model: modelName,
        max_tokens: 4096,
        messages: openaiMessages,
        tools: toolsToSend,
        tool_choice: toolsToSend ? 'auto' : undefined, // Only set if tools are present
      } as any); // Cast as any because OpenAI SDK might not have all properties

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
