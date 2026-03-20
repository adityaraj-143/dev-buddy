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
    // Convert messages to OpenAI format
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: this.systemPrompt,
      },
      ...messages.map((msg) => ({
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content || '',
      })),
    ];

    // Call Groq API
    const response = await this.client.chat.completions.create({
      model: modelName,
      max_tokens: 4096,
      messages: openaiMessages,
      tools: tools.length > 0 ? tools : undefined,
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
