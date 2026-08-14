/**
 * GeminiLlmProvider — Real LLM provider using Google Gemini Flash.
 *
 * Uses the Generative Language REST API (no SDK dependency needed).
 * Supports:
 *   - Multilingual conversation (Yoruba, Igbo, Hausa, Pidgin, English)
 *   - Tool/function calling for banking intents
 *   - Conversation history for context-aware responses
 *
 * Free tier: 15 req/min, 1500 req/day (gemini-2.0-flash)
 * Get API key: https://aistudio.google.com/apikey
 */

import type { LlmProvider, LlmRequest, LlmResponse } from '@adunni/shared-types';

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-latest';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_STREAM_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent`;

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiGenerateRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  generationConfig: {
    maxOutputTokens: number;
    temperature: number;
  };
}

interface GeminiGenerateResponse {
  candidates: Array<{
    content: {
      role: string;
      parts: GeminiPart[];
    };
    finishReason: string;
  }>;
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export class GeminiLlmProvider implements LlmProvider {
  name = 'gemini-flash';
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.GEMINI_API_KEY ?? '';
    if (!this.apiKey) {
      console.warn('[gemini-llm] GEMINI_API_KEY not set — provider will fail on requests');
    }
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not set');
    }

    // Build system instruction with language directive
    const systemParts: string[] = [request.systemPrompt];

    // Build conversation contents (Gemini uses "user" and "model" roles)
    const contents: GeminiContent[] = [];

    // Add conversation history
    for (const turn of request.conversationHistory) {
      contents.push({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: turn.content }],
      });
    }

    // Add current user message
    contents.push({
      role: 'user',
      parts: [{ text: request.userMessage }],
    });

    // Build tools (function declarations) if any
    const tools: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }> = [];
    if (request.tools.length > 0) {
      tools.push({
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>,
        })),
      });
    }

    const body: GeminiGenerateRequest = {
      contents,
      systemInstruction: { parts: [{ text: systemParts.join('\n\n') }] },
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        temperature: request.temperature,
      },
    };

    if (tools.length > 0) {
      body.tools = tools;
    }

    const url = `${GEMINI_ENDPOINT}?key=${this.apiKey}`;

    // Retry on 503 (overloaded) with exponential backoff
    let resp: Response | null = null;
    let lastError: string = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      if (resp.ok) break;

      const errText = await resp.text();
      lastError = errText;

      if (resp.status === 503 && attempt < 2) {
        // Wait 1s, then 2s before retrying
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }

      throw new Error(`Gemini API error (${resp.status}): ${errText}`);
    }

    if (!resp || !resp.ok) {
      throw new Error(`Gemini API error: ${lastError}`);
    }

    const data = (await resp.json()) as GeminiGenerateResponse;

    if (!data.candidates || data.candidates.length === 0) {
      return {
        text: 'I apologize, but I was unable to generate a response.',
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }

    const candidate = data.candidates[0];
    const parts = candidate.content?.parts ?? [];

    // Extract text and function calls from parts
    let text = '';
    const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

    for (const part of parts) {
      if (part.text) {
        text += part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
    }

    const usage = data.usageMetadata ?? {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    };

    return {
      text: text.trim(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
      },
    };
  }

  /**
   * Streaming completion — calls onChunk with text as it arrives from Gemini.
   * Returns the final LlmResponse with full text + tool calls.
   * Falls back to non-streaming if streaming fails.
   */
  async streamComplete(request: LlmRequest, onChunk: (text: string) => void): Promise<LlmResponse> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not set');
    }

    // Build the same request body as complete()
    const systemParts: string[] = [request.systemPrompt];
    const contents: GeminiContent[] = [];

    for (const turn of request.conversationHistory) {
      contents.push({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: turn.content }],
      });
    }
    contents.push({ role: 'user', parts: [{ text: request.userMessage }] });

    const tools: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }> = [];
    if (request.tools.length > 0) {
      tools.push({
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>,
        })),
      });
    }

    const body: GeminiGenerateRequest = {
      contents,
      systemInstruction: { parts: [{ text: systemParts.join('\n\n') }] },
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        temperature: request.temperature,
      },
    };
    if (tools.length > 0) body.tools = tools;

    const url = `${GEMINI_STREAM_ENDPOINT}?key=${this.apiKey}&alt=sse`;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok || !resp.body) {
        // Fall back to non-streaming
        console.warn('[gemini-llm] streaming failed, falling back to non-streaming');
        return this.complete(request);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines (data: {...})
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(jsonStr) as GeminiGenerateResponse;
            if (chunk.candidates && chunk.candidates.length > 0) {
              const parts = chunk.candidates[0].content?.parts ?? [];
              for (const part of parts) {
                if (part.text) {
                  fullText += part.text;
                  onChunk(part.text);
                }
                if (part.functionCall) {
                  toolCalls.push({
                    name: part.functionCall.name,
                    arguments: part.functionCall.args ?? {},
                  });
                }
              }
            }
            if (chunk.usageMetadata) {
              totalInputTokens = chunk.usageMetadata.promptTokenCount ?? totalInputTokens;
              totalOutputTokens = chunk.usageMetadata.candidatesTokenCount ?? totalOutputTokens;
            }
          } catch {
            // Partial JSON, skip
          }
        }
      }

      return {
        text: fullText.trim(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      };
    } catch (err) {
      console.warn('[gemini-llm] streaming error, falling back:', err instanceof Error ? err.message : err);
      return this.complete(request);
    }
  }
}
