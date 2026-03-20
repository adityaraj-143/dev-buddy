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

    // Call Groq API
    const apiMessages = JSON.parse(JSON.stringify(openaiMessages));
    if (process.env.DEBUG === '1' || process.env.DEBUG === 'true') {
      console.error('[GROQ_DEBUG] Messages being sent:', JSON.stringify(apiMessages, null, 2));
      console.error('[GROQ_DEBUG] Tools:', JSON.stringify(tools, null, 2));
    }
    
    const response = await this.client.chat.completions.create({
      model: modelName,
      max_tokens: 4096,
      messages: openaiMessages,
      tools: tools && tools.length > 0 ? tools : undefined,
    });

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
  }
}
