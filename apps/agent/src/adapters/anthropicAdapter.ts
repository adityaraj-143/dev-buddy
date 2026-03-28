/**
 * Anthropic API Adapter
 * 
 * Adapts Anthropic's message format to OpenAI-compatible format
 * and vice versa, to maintain compatibility with the existing agent.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Message, OpenAIToolCall } from '../core/types';

export class AnthropicAdapter {
  private client: Anthropic;
  private systemPrompt: string;

  constructor(apiKey: string, systemPrompt: string) {
    this.client = new Anthropic({ apiKey });
    this.systemPrompt = systemPrompt;
  }

  /**
   * Convert OpenAI-style messages to Anthropic format
   * Handles: system (via param), user, assistant with tool_use, tool results in user message
   */
  private convertMessagesToAnthropicFormat(
    messages: Message[]
  ): Anthropic.Messages.MessageParam[] {
    const anthropicMessages: Anthropic.Messages.MessageParam[] = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];
      if (!msg) { i++; continue; }

      if (msg.role === 'system') {
        // After first system message, treat subsequent system messages as user messages
        // since Anthropic API doesn't support multiple system messages
        if (anthropicMessages.length > 0) {
          anthropicMessages.push({
            role: 'user',
            content: msg.content || '',
          });
        }
        i++;
        continue;
      }

      if (msg.role === 'user') {
        anthropicMessages.push({
          role: 'user',
          content: (msg.content || '').trim(),
        });
        i++;
      } else if (msg.role === 'assistant') {
        const blocks: (Anthropic.Messages.TextBlockParam | Anthropic.Messages.ToolUseBlockParam)[] = [];

        if (msg.content) {
          blocks.push({ type: 'text', text: msg.content.trim() });
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const toolCall of msg.tool_calls) {
            const args = JSON.parse(toolCall.function.arguments);
            blocks.push({
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.function.name,
              input: args,
            });
          }
        }

        anthropicMessages.push({
          role: 'assistant',
          content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }],
        });

        // Collect tool results
        i++;
        const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] = [];

        while (i < messages.length && messages[i]?.role === 'tool') {
          const toolMsg = messages[i];
          if (toolMsg) {
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: toolMsg.tool_call_id || '',
              content: toolMsg.content || '',
            });
          }
          i++;
        }

        if (toolResultBlocks.length > 0) {
          anthropicMessages.push({
            role: 'user',
            content: toolResultBlocks,
          });
        }
      } else {
        i++;
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

    // Anthropic requires at least one non-system message
    if (anthropicMessages.length === 0) {
      anthropicMessages.push({
        role: 'user',
        content: 'Continue',
      });
    }

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
