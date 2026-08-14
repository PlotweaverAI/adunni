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

    return `You are ${config.voicePersona.name}, an AI voice agent for ${config.clientName}.
You speak these languages: ${langList}.
You can code-switch mid-conversation based on the caller's language.

You are authorized to handle ONLY these intents:
${intentList}

Rules:
- Detect the caller's language and respond in the same language.
- For any action that mutates data (requires confirmation), you MUST ask for explicit confirmation before executing.
- If the caller's request is outside your configured intents, escalate to a human agent.
- Never ask for or process card numbers, PINs, or raw authentication credentials.
- Be warm, professional, and concise. This is a voice conversation — keep responses short enough to speak naturally.
- Maintain context across language switches.

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
    const conversationHistory = context.turns.map((t) => ({
      role: (t.speaker === 'ai' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: t.text,
    }));

    const llmResponse = await this.llm.complete({
      systemPrompt,
      conversationHistory,
      userMessage: userUtterance,
      tools,
      maxTokens: 300,
      temperature: 0.7,
    });

    let decision: OrchestratorDecision;
    let intentName: string | undefined;
    let confidence = 0.85;

    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
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

  private detectConfirmation(utterance: string, _language: LanguageCode): boolean {
    const lower = utterance.toLowerCase();
    const confirmWords = ['yes', 'yeah', 'confirm', 'okay', 'ok', 'sure', 'go ahead', 'amince', 'ẹ', 'correct', 'right'];
    const denyWords = ['no', 'nope', 'cancel', 'stop', 'don\'t', 'rárã', 'a\'a'];
    return confirmWords.some((w) => lower.includes(w)) && !denyWords.some((w) => lower.includes(w));
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
