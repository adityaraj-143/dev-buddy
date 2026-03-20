/**
 * Anthropic API Adapter
 * 
 * Adapts Anthropic's message format to OpenAI-compatible format
 * and vice versa, to maintain compatibility with the existing agent.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Message, OpenAIToolCall } from './types';

export class AnthropicAdapter {
  private client: Anthropic;
  private systemPrompt: string;

  constructor(apiKey: string, systemPrompt: string) {
    this.client = new Anthropic({ apiKey });
    this.systemPrompt = systemPrompt;
  }

  /**
   * Convert OpenAI-style messages to Anthropic format
   * - Remove system messages (handled separately)
   * - Convert tool messages to user messages with tool result content
   */
  private convertMessagesToAnthropicFormat(
    messages: Message[]
  ): Anthropic.Messages.MessageParam[] {
    const anthropicMessages: Anthropic.Messages.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // System messages are handled via the system parameter
        continue;
      }

      if (msg.role === 'tool') {
        // Convert tool messages to user messages
        // Anthropic doesn't have a "tool" role - tool results go in user messages
        anthropicMessages.push({
          role: 'user',
          content: msg.content || 'Tool result received',
        });
      } else if (msg.role === 'assistant') {
        // Assistant messages may contain tool calls
        const toolUseBlocks: Anthropic.Messages.ToolUseBlockParam[] = [];
        const textContent = msg.content || '';

        // If there are tool calls, add them as tool_use blocks
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const toolCall of msg.tool_calls) {
            const args = JSON.parse(toolCall.function.arguments);
            toolUseBlocks.push({
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.function.name,
              input: args,
            });
          }
        }

        // Build the content array
        const content: (Anthropic.Messages.TextBlockParam | Anthropic.Messages.ToolUseBlockParam)[] = [];
        if (textContent) {
          content.push({
            type: 'text',
            text: textContent,
          });
        }
        content.push(...toolUseBlocks);

        anthropicMessages.push({
          role: 'assistant',
          content: content.length > 0 ? content : [{ type: 'text', text: '' }],
        });
      } else if (msg.role === 'user') {
        anthropicMessages.push({
          role: 'user',
          content: msg.content || '',
        });
      }
    }

    return anthropicMessages;
  }

  /**
   * Convert Anthropic response to OpenAI-compatible format
   */
  private convertResponseToOpenAIFormat(
    anthropicMessage: Anthropic.Messages.Message
  ): Message {
    const message: Message = {
      role: 'assistant',
      content: '',
      tool_calls: [],
    };

    for (const block of anthropicMessage.content) {
      if (block.type === 'text') {
        message.content = block.text;
      } else if (block.type === 'tool_use') {
        message.tool_calls!.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return message;
  }

  /**
   * Call Anthropic API with OpenAI-compatible interface
   */
  async createMessage(
    messages: Message[],
    tools: any[],
    modelName: string
  ): Promise<Message> {
    // Convert tools to Anthropic format
    const anthropicTools: Anthropic.Messages.Tool[] = tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));

    // Convert messages to Anthropic format
    const anthropicMessages = this.convertMessagesToAnthropicFormat(messages);

    // Call Anthropic API
    const response = await this.client.messages.create({
      model: modelName,
      max_tokens: 4096,
      system: this.systemPrompt,
      tools: anthropicTools,
      messages: anthropicMessages,
    });

    // Convert response back to OpenAI format
    return this.convertResponseToOpenAIFormat(response);
  }
}
