import type {
  OrchestratorService,
  OrchestratorRequest,
  OrchestratorResponse,
  OrchestratorDecision,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ClientConfig,
  IntentConfig,
  LanguageCode,
  EscalationReason,
  ConversationContext,
} from '@adunni/shared-types';
import { LANGUAGE_NAMES } from '@adunni/shared-types';

export class MockLlmProvider implements LlmProvider {
  name = 'mock-llm';

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const { userMessage, tools, conversationHistory } = request;
    const lower = userMessage.toLowerCase();

    if (tools.length > 0) {
      for (const tool of tools) {
        if (tool.name === 'get_balance' && (lower.includes('balance') || lower.includes('how much') || lower.includes('owo') || lower.includes('kudi') || lower.includes('ego') || lower.includes('akanti'))) {
          return {
            text: '',
            toolCalls: [{ name: 'get_balance', arguments: { account_id: 'ACC-001' } }],
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        }
        if (tool.name === 'update_transfer_limit' && (lower.includes('limit') || lower.includes('raise'))) {
          return {
            text: '',
            toolCalls: [{ name: 'update_transfer_limit', arguments: { account_id: 'ACC-001', new_limit: 100000 } }],
            usage: { inputTokens: 130, outputTokens: 70 },
          };
        }
        if (tool.name === 'get_transfer_status' && (
          lower.includes('transfer status') ||
          lower.includes('transfer gone') ||
          (lower.includes('transfer') && (lower.includes('send') || lower.includes('money') || lower.includes('owó') || lower.includes('kudin') || lower.includes('chigo')))
        )) {
          return {
            text: '',
            toolCalls: [{ name: 'get_transfer_status', arguments: { transfer_id: 'TRX-2026-001' } }],
            usage: { inputTokens: 120, outputTokens: 60 },
          };
        }
      }
    }

    const lastAssistant = [...conversationHistory].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant && (lower.includes('yes') || lower.includes('confirm') || lower.includes('okay') || lower.includes('amince') || lower.includes('ẹ'))) {
      return {
        text: 'Confirmed. I will proceed with that action now.',
        usage: { inputTokens: 80, outputTokens: 40 },
      };
    }

    if (lower.includes('statement')) {
      return {
        text: 'I can help with account balance, transfer status, or transfer limits. Bank statements are not available yet. If you need one, I can connect you to a human agent.',
        usage: { inputTokens: 110, outputTokens: 46 },
      };
    }

    if (lower.includes('detail') || lower.includes('details') || lower.includes('more info')) {
      return {
        text: 'I can help with account balance, transfer status, or transfer limits. Which one do you need?',
        usage: { inputTokens: 100, outputTokens: 42 },
      };
    }

    if (lower.includes('thank') || lower.includes('daalụ') || lower.includes('madalla')) {
      return {
        text: "You're welcome! Is there anything else I can help you with today?",
        usage: { inputTokens: 90, outputTokens: 35 },
      };
    }

    return {
      text: 'I can help with account balance, transfer status, or transfer limits. What would you like to do?',
      usage: { inputTokens: 100, outputTokens: 45 },
    };
  }
}

export class OrchestratorServiceImpl implements OrchestratorService {
  private llm: LlmProvider;

  constructor(llm?: LlmProvider) {
    this.llm = llm ?? new MockLlmProvider();
  }

  buildSystemPrompt(config: ClientConfig): string {
    const intentList = config.intents
      .map((i) => `- ${i.name}: ${i.description} (action: ${i.actionName}, requires confirmation: ${i.requiresConfirmation})`)
      .join('\n');

    const langList = config.allowedLanguages.map((l) => LANGUAGE_NAMES[l]).join(', ');

    return `You are ${config.voicePersona.name}, a warm and intelligent Nigerian AI conversational voice agent.
You speak these languages natively: ${langList}.
You can code-switch mid-conversation based on the caller's language.

You are a GENERAL conversational agent — you can chat naturally about anything, be a companion, answer questions, tell stories, share jokes, give advice, and also help with specific tasks when needed.

When the caller asks for something that matches a configured task, use the available tools:
${intentList}

Rules:
- ALWAYS respond in the same language the caller is speaking. If they speak Igbo, respond in Igbo. If Yoruba, respond in Yoruba. If Pidgin, respond in Pidgin. If English, respond in English.
- NEVER respond in English when the caller is speaking a Nigerian language. Respond natively in their language.
- Be conversational and natural — not robotic. Ask follow-up questions, show interest, be engaging.
- Be warm, friendly, and culturally aware. You are a Nigerian AI — use appropriate greetings and cultural references.
- Keep responses SHORT (1-3 sentences) since this is a voice conversation. Don't monologue.
- For any action that mutates data (requires confirmation), you MUST ask for explicit confirmation before executing.
- If the caller asks for something outside your configured tools, still try to help conversationally. Only offer to connect to a human agent if they specifically request it or if a task truly requires human intervention.
- Never ask for or process card numbers, PINs, or raw authentication credentials.
- Maintain context across turns. Remember what the caller said earlier in the conversation.
- If the caller's request is unclear, ask a brief clarifying question in their language.
- If the caller is just chatting (not requesting a task), just chat naturally. Don't force task-related responses.

Escalation rules:
- If confidence is below ${config.escalationRules.confidenceThreshold}, escalate.
- Maximum ${config.escalationRules.maxRetries} retries before escalation.
- Escalation mode: ${config.escalationRules.handoffMode}.`;
  }

  buildTools(intents: IntentConfig[]): LlmRequest['tools'] {
    return intents.map((intent) => ({
      name: intent.actionName,
      description: intent.description,
      parameters: {
        type: 'object',
        properties: intent.requiredSlots.reduce((acc, slot) => {
          acc[slot] = { type: 'string', description: `The ${slot} for ${intent.actionName}` };
          return acc;
        }, {} as Record<string, unknown>),
        required: intent.requiredSlots,
      },
    }));
  }

  async process(request: OrchestratorRequest): Promise<OrchestratorResponse> {
    const startTime = Date.now();
    const { config, context, userUtterance, detectedLanguage, languageConfidence } = request;

    if (languageConfidence < config.escalationRules.confidenceThreshold) {
      const decision: OrchestratorDecision = {
        type: 'escalate',
        reason: 'low_confidence' as EscalationReason,
        message: config.escalationRules.handoffMessage ?? 'Let me connect you to a human agent.',
        language: detectedLanguage,
      };
      return {
        decision,
        confidence: languageConfidence,
        updatedContext: this.updateContext(context, decision, detectedLanguage),
        latencyMs: Date.now() - startTime,
      };
    }

    if (context.dialogueState.awaitingConfirmation && context.pendingAction) {
      const confirmed = this.detectConfirmation(userUtterance, detectedLanguage);
      const decision: OrchestratorDecision = {
        type: 'confirm_action',
        actionId: context.pendingAction.id,
        confirmed,
        language: detectedLanguage,
      };
      return {
        decision,
        confidence: 0.9,
        updatedContext: this.updateContext(context, decision, detectedLanguage),
        latencyMs: Date.now() - startTime,
      };
    }

    const systemPrompt = this.buildSystemPrompt(config);
    const tools = this.buildTools(config.intents);

    // Context window management: keep last 8 turns as full text,
    // summarize older turns to keep Gemini context small and fast
    const allTurns = context.turns;
    const recentTurns = allTurns.slice(-8);
    const olderTurns = allTurns.slice(0, -8);

    const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // Add a summary of older conversation if there are any
    if (olderTurns.length > 0) {
      const summary = olderTurns.map((t) =>
        `${t.speaker === 'ai' ? 'Adunni' : 'User'}: ${t.text.slice(0, 100)}`
      ).join(' | ');
      conversationHistory.push({
        role: 'user',
        content: `[Earlier in our conversation: ${summary}]`,
      });
      conversationHistory.push({
        role: 'assistant',
        content: 'Understood, I remember our earlier conversation.',
      });
    }

    // Add recent turns as full text
    for (const turn of recentTurns) {
      conversationHistory.push({
        role: (turn.speaker === 'ai' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: turn.text,
      });
    }

    // Inject detected language hint so the LLM knows which language to respond in
    const langName = LANGUAGE_NAMES[detectedLanguage] ?? detectedLanguage;
    const userMessageWithContext = `[Detected language: ${langName}]\n${userUtterance}`;

    let llmResponse;
    try {
      llmResponse = await this.llm.complete({
        systemPrompt,
        conversationHistory,
        userMessage: userMessageWithContext,
        tools,
        maxTokens: 300,
        temperature: 0.7,
      });
    } catch (llmErr) {
      console.error('[orchestrator] LLM failed, using fallback:', llmErr instanceof Error ? llmErr.message : llmErr);
      // Fallback: return a simple response so the user isn't left hanging
      const fallbackText = detectedLanguage === 'yo' ? 'Pardon me, mo n ba e se. Nje o le so leyi lẹẹkansi?'
        : detectedLanguage === 'ha' ? 'Gafara, zan iya sake faɗin wannan?'
        : detectedLanguage === 'ig' ? 'Biko, m ga-ekwu ya ọzọ?'
        : detectedLanguage === 'pcm' ? 'Sorry, abeg you fit repeat that one again?'
        : "I'm sorry, I didn't catch that. Could you please repeat?";
      const fallbackDecision: OrchestratorDecision = {
        type: 'respond',
        text: fallbackText,
        language: detectedLanguage,
      };
      return {
        decision: fallbackDecision,
        confidence: 0.5,
        updatedContext: this.updateContext(context, fallbackDecision, detectedLanguage),
        latencyMs: Date.now() - startTime,
      };
    }

    let decision: OrchestratorDecision;
    let intentName: string | undefined;
    let confidence = 0.85;

    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      // Multi-turn tool calling: process all tool calls in sequence
      // For the first tool call, create the decision. If multiple tools,
      // chain them by noting the sequence in the response.
      const toolCall = llmResponse.toolCalls[0];
      const intent = config.intents.find((i) => i.actionName === toolCall.name);

      if (!intent) {
        decision = {
          type: 'escalate',
          reason: 'out_of_scope' as EscalationReason,
          message: config.escalationRules.handoffMessage ?? 'Let me connect you to a human agent.',
          language: detectedLanguage,
        };
      } else if (intent.requiresConfirmation) {
        intentName = intent.name;
        decision = {
          type: 'action',
          intentName: intent.name,
          actionName: intent.actionName,
          parameters: toolCall.arguments,
          requiresConfirmation: true,
          confirmationPrompt: `I will ${intent.description.toLowerCase()}. Do you confirm this action?`,
          language: detectedLanguage,
        };
        // If there are more tool calls queued, mention them in the confirmation
        if (llmResponse.toolCalls.length > 1) {
          const nextTools = llmResponse.toolCalls.slice(1).map((tc) => {
            const i = config.intents.find((x) => x.actionName === tc.name);
            return i ? i.name : tc.name;
          });
          (decision as { confirmationPrompt: string }).confirmationPrompt +=
            ` After that, I'll also: ${nextTools.join(', ')}.`;
        }
      } else {
        intentName = intent.name;
        decision = {
          type: 'action',
          intentName: intent.name,
          actionName: intent.actionName,
          parameters: toolCall.arguments,
          requiresConfirmation: false,
          confirmationPrompt: '',
          language: detectedLanguage,
        };
        // If multiple tools, include the text response with context about the chain
        if (llmResponse.toolCalls.length > 1 && llmResponse.text) {
          (decision as { text?: string }).text = llmResponse.text;
        }
      }
    } else {
      decision = {
        type: 'respond',
        text: llmResponse.text,
        language: detectedLanguage,
      };
    }

    return {
      decision,
      intentName,
      confidence,
      updatedContext: this.updateContext(context, decision, detectedLanguage),
      latencyMs: Date.now() - startTime,
    };
  }

  private detectConfirmation(utterance: string, _language: LanguageCode): boolean {
    const lower = utterance.toLowerCase();
    const confirmWords = ['yes', 'yeah', 'confirm', 'okay', 'ok', 'sure', 'go ahead', 'amince', 'ẹ', 'correct', 'right'];
    const denyWords = ['no', 'nope', 'cancel', 'stop', 'don\'t', 'rárã', 'a\'a'];
    return confirmWords.some((w) => lower.includes(w)) && !denyWords.some((w) => lower.includes(w));
  }

  /**
   * Streaming version of process() — calls onText for each text chunk from the LLM.
   * Returns the final OrchestratorResponse (same as process()).
   * 
   * For tool calls (actions), streaming is not possible — the full LLM response
   * is needed to determine the tool call. In that case, onText is not called
   * and the response is returned normally.
   */
  async processStream(
    request: OrchestratorRequest,
    onText: (text: string) => void
  ): Promise<OrchestratorResponse> {
    const startTime = Date.now();
    const { config, context, userUtterance, detectedLanguage, languageConfidence } = request;

    if (!config) {
      throw new Error('Client config not loaded');
    }

    // Handle confirmation/action cases without streaming (they need full response)
    if (context.dialogueState.awaitingConfirmation && context.pendingAction) {
      const confirmed = this.detectConfirmation(userUtterance, detectedLanguage);
      const decision: OrchestratorDecision = {
        type: 'confirm_action',
        actionId: context.pendingAction.id,
        confirmed,
        language: detectedLanguage,
      };
      return {
        decision,
        confidence: 0.9,
        updatedContext: this.updateContext(context, decision, detectedLanguage),
        latencyMs: Date.now() - startTime,
      };
    }

    if (languageConfidence < config.escalationRules.confidenceThreshold) {
      const decision: OrchestratorDecision = {
        type: 'escalate',
        reason: 'low_confidence' as EscalationReason,
        message: config.escalationRules.handoffMessage ?? 'Let me connect you to a human agent.',
        language: detectedLanguage,
      };
      return {
        decision,
        confidence: languageConfidence,
        updatedContext: this.updateContext(context, decision, detectedLanguage),
        latencyMs: Date.now() - startTime,
      };
    }

    const systemPrompt = this.buildSystemPrompt(config);
    const tools = this.buildTools(config.intents);

    const allTurns = context.turns;
    const recentTurns = allTurns.slice(-8);
    const olderTurns = allTurns.slice(0, -8);

    const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = olderTurns.length > 0
      ? [{ role: 'assistant', content: `[Previous conversation summary: ${olderTurns.length} earlier turns]` }]
      : [];
    for (const turn of recentTurns) {
      conversationHistory.push({
        role: (turn.speaker === 'ai' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: turn.text,
      });
    }

    const langName = LANGUAGE_NAMES[detectedLanguage] ?? detectedLanguage;
    const userMessageWithContext = `[Detected language: ${langName}]\n${userUtterance}`;

    let llmResponse: LlmResponse;

    // Try streaming if the LLM supports it
    if (this.llm && 'streamComplete' in this.llm && typeof this.llm.streamComplete === 'function') {
      try {
        llmResponse = await this.llm.streamComplete(
          {
            systemPrompt,
            conversationHistory,
            userMessage: userMessageWithContext,
            tools,
            maxTokens: 300,
            temperature: 0.7,
          },
          (chunk: string) => {
            // Only stream text chunks — if it's a tool call, don't stream
            if (chunk && chunk.trim()) {
              onText(chunk);
            }
          }
        );
      } catch (err) {
        console.warn('[orchestrator] streaming failed, falling back to complete:', err instanceof Error ? err.message : err);
        llmResponse = await this.llm.complete({
          systemPrompt,
          conversationHistory,
          userMessage: userMessageWithContext,
          tools,
          maxTokens: 300,
          temperature: 0.7,
        });
      }
    } else if (this.llm) {
      llmResponse = await this.llm.complete({
        systemPrompt,
        conversationHistory,
        userMessage: userMessageWithContext,
        tools,
        maxTokens: 300,
        temperature: 0.7,
      });
    } else {
      // No LLM — use mock
      llmResponse = await new MockLlmProvider().complete({
        systemPrompt,
        conversationHistory,
        userMessage: userMessageWithContext,
        tools,
        maxTokens: 300,
        temperature: 0.7,
      });
    }

    let decision: OrchestratorDecision;
    let intentName: string | undefined;
    let confidence = 0.85;

    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      // Tool call — don't use streamed text, construct the action decision
      const toolCall = llmResponse.toolCalls[0];
      const intent = config.intents.find((i) => i.actionName === toolCall.name);

      if (!intent) {
        decision = {
          type: 'escalate',
          reason: 'out_of_scope' as EscalationReason,
          message: config.escalationRules.handoffMessage ?? 'Let me connect you to a human agent.',
          language: detectedLanguage,
        };
      } else if (intent.requiresConfirmation) {
        intentName = intent.name;
        decision = {
          type: 'action',
          intentName: intent.name,
          actionName: intent.actionName,
          parameters: toolCall.arguments,
          requiresConfirmation: true,
          confirmationPrompt: `I will ${intent.description.toLowerCase()}. Do you confirm this action?`,
          language: detectedLanguage,
        };
      } else {
        intentName = intent.name;
        decision = {
          type: 'action',
          intentName: intent.name,
          actionName: intent.actionName,
          parameters: toolCall.arguments,
          requiresConfirmation: false,
          confirmationPrompt: '',
          language: detectedLanguage,
        };
      }
    } else {
      decision = {
        type: 'respond',
        text: llmResponse.text,
        language: detectedLanguage,
      };
    }

    return {
      decision,
      intentName,
      confidence,
      updatedContext: this.updateContext(context, decision, detectedLanguage),
      latencyMs: Date.now() - startTime,
    };
  }

  private updateContext(context: ConversationContext, decision: OrchestratorDecision, language: LanguageCode): ConversationContext {
    return {
      ...context,
      lastLanguage: language,
      dialogueState: {
        ...context.dialogueState,
        currentIntent: decision.type === 'action' ? decision.intentName : context.dialogueState.currentIntent,
        awaitingConfirmation: decision.type === 'action' && decision.requiresConfirmation,
        escalationActive: decision.type === 'escalate',
      },
    };
  }
}
