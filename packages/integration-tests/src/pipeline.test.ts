import { AsrServiceImpl } from '@adunni/asr-service';
import { TtsServiceImpl } from '@adunni/tts-service';
import { OrchestratorServiceImpl } from '@adunni/orchestrator';
import type {
  ClientConfig,
  OrchestratorRequest,
  ConversationContext,
  LanguageCode,
} from '@adunni/shared-types';

const SAVANNA_CONFIG: ClientConfig = {
  clientId: 'savanna-bank',
  clientName: 'Savanna Bank',
  allowedLanguages: ['en-NG', 'pcm', 'yo', 'ig', 'ha'],
  defaultLanguage: 'en-NG',
  voicePersona: {
    name: 'Àdùnní',
    ttsVoiceId: 'adunni-yo-04',
    ttsProvider: 'commercial',
    speakingRate: 1.0,
    pitch: 0,
  },
  intents: [
    {
      name: 'check_balance',
      description: 'Check the caller account balance',
      utteranceExamples: ['What is my balance?'],
      actionName: 'get_balance',
      requiredSlots: ['account_id'],
      requiresConfirmation: false,
      escalationOnFailure: true,
    },
    {
      name: 'transfer_status',
      description: 'Check the status of a pending transfer',
      utteranceExamples: ['Has my transfer gone through?'],
      actionName: 'get_transfer_status',
      requiredSlots: ['transfer_id'],
      requiresConfirmation: false,
      escalationOnFailure: true,
    },
    {
      name: 'raise_transfer_limit',
      description: 'Raise the daily transfer limit',
      utteranceExamples: ['Please increase my transfer limit'],
      actionName: 'update_transfer_limit',
      requiredSlots: ['account_id', 'new_limit'],
      requiresConfirmation: true,
      escalationOnFailure: true,
    },
  ],
  escalationRules: {
    confidenceThreshold: 0.65,
    maxRetries: 2,
    handoffMode: 'explicit_message',
    handoffMessage: 'Let me connect you to a human agent who can help further.',
  },
  ndprConsentMessage: 'This call may be recorded.',
  audioRetentionHours: 24,
  transcriptRetentionDays: 90,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function emptyContext(sessionId: string): ConversationContext {
  return {
    sessionId,
    turns: [],
    referencedEntities: {},
    lastLanguage: 'en-NG',
    dialogueState: { awaitingConfirmation: false, slots: {}, escalationActive: false },
  };
}

describe('ASR Service', () => {
  const asr = new AsrServiceImpl();

  test('detects Nigerian English', async () => {
    const result = await asr.detectLanguage('What is my account balance please?');
    expect(result.language).toBe('en-NG');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test('detects Pidgin', async () => {
    const result = await asr.detectLanguage('Abeg na, my money never show. Wetin dey happen?');
    expect(result.language).toBe('pcm');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test('detects Yorùbá', async () => {
    const result = await asr.detectLanguage('Ẹ jọ̀wọ́, iye owó tó wà nínú àkántì mi kúrò?');
    expect(result.language).toBe('yo');
  });

  test('detects Hausa', async () => {
    const result = await asr.detectLanguage('Madalla, Zan aika mata saƙon tabbatarwa da karɓi daga Komai shirye yake sai amince');
    expect(result.language).toBe('ha');
  });

  test('detects Igbo', async () => {
    const result = await asr.detectLanguage('Daalụ, Ị na-asụ Igbo? ego m ruola ọma');
    expect(result.language).toBe('ig');
  });

  test('returns provider info', () => {
    const info = asr.getProviderInfo();
    expect(info.name).toBe('mock-asr');
    expect(info.supportedLanguages).toHaveLength(5);
  });
});

describe('TTS Service', () => {
  const tts = new TtsServiceImpl();

  test('synthesizes text to audio chunks', (done) => {
    const stream = tts.synthesize({
      text: 'Hello, how can I help you today?',
      language: 'en-NG' as LanguageCode,
      voicePersona: SAVANNA_CONFIG.voicePersona,
      sessionId: 'test-session',
      turnId: 'test-turn',
    });

    const chunks: Buffer[] = [];
    stream.onChunk((chunk) => {
      if (chunk.isFinal) {
        expect(chunks.length).toBeGreaterThan(0);
        done();
      } else {
        chunks.push(chunk.audio);
      }
    });
    stream.onError((err) => done(err));
  });

  test('returns provider info', () => {
    const info = tts.getProviderInfo();
    expect(info.name).toBe('mock-tts');
    expect(info.supportedLanguages).toHaveLength(5);
  });
});

describe('Orchestrator Service', () => {
  const orchestrator = new OrchestratorServiceImpl();

  test('builds system prompt with client config', () => {
    const prompt = orchestrator.buildSystemPrompt(SAVANNA_CONFIG);
    expect(prompt).toContain('Àdùnní');
    expect(prompt).toContain('Savanna Bank');
    expect(prompt).toContain('check_balance');
    expect(prompt).toContain('raise_transfer_limit');
  });

  test('builds tools from intents', () => {
    const tools = orchestrator.buildTools(SAVANNA_CONFIG.intents);
    expect(tools).toHaveLength(3);
    expect(tools[0].name).toBe('get_balance');
    expect(tools[1].name).toBe('get_transfer_status');
    expect(tools[2].name).toBe('update_transfer_limit');
  });

  test('resolves balance inquiry intent', async () => {
    const request: OrchestratorRequest = {
      sessionId: 'test-1',
      clientId: 'savanna-bank',
      config: SAVANNA_CONFIG,
      context: emptyContext('test-1'),
      userUtterance: 'What is my account balance?',
      detectedLanguage: 'en-NG',
      languageConfidence: 0.9,
    };

    const response = await orchestrator.process(request);
    expect(response.decision.type).toBe('action');
    if (response.decision.type === 'action') {
      expect(response.decision.actionName).toBe('get_balance');
      expect(response.decision.requiresConfirmation).toBe(false);
    }
  });

  test('resolves transfer status intent', async () => {
    const request: OrchestratorRequest = {
      sessionId: 'test-2',
      clientId: 'savanna-bank',
      config: SAVANNA_CONFIG,
      context: emptyContext('test-2'),
      userUtterance: 'Has my transfer gone through? I need to know the status of my money.',
      detectedLanguage: 'en-NG',
      languageConfidence: 0.85,
    };

    const response = await orchestrator.process(request);
    expect(response.decision.type).toBe('action');
    if (response.decision.type === 'action') {
      expect(response.decision.actionName).toBe('get_transfer_status');
    }
  });

  test('requires confirmation for limit increase', async () => {
    const request: OrchestratorRequest = {
      sessionId: 'test-3',
      clientId: 'savanna-bank',
      config: SAVANNA_CONFIG,
      context: emptyContext('test-3'),
      userUtterance: 'Please raise my transfer limit to 100000',
      detectedLanguage: 'en-NG',
      languageConfidence: 0.88,
    };

    const response = await orchestrator.process(request);
    expect(response.decision.type).toBe('action');
    if (response.decision.type === 'action') {
      expect(response.decision.actionName).toBe('update_transfer_limit');
      expect(response.decision.requiresConfirmation).toBe(true);
      expect(response.decision.confirmationPrompt).toBeTruthy();
    }
  });

  test('escalates on low confidence', async () => {
    const request: OrchestratorRequest = {
      sessionId: 'test-4',
      clientId: 'savanna-bank',
      config: SAVANNA_CONFIG,
      context: emptyContext('test-4'),
      userUtterance: 'xyz qwerty asdf',
      detectedLanguage: 'en-NG',
      languageConfidence: 0.3,
    };

    const response = await orchestrator.process(request);
    expect(response.decision.type).toBe('escalate');
    if (response.decision.type === 'escalate') {
      expect(response.decision.reason).toBe('low_confidence');
      expect(response.decision.message).toContain('human agent');
    }
  });

  test('handles confirmation flow', async () => {
    const contextWithPending: ConversationContext = {
      ...emptyContext('test-5'),
      pendingAction: {
        id: 'action-1',
        sessionId: 'test-5',
        turnId: 'turn-0',
        intentName: 'raise_transfer_limit',
        actionName: 'update_transfer_limit',
        parameters: { account_id: 'ACC-001', new_limit: 100000 },
        status: 'pending',
        createdAt: new Date(),
      },
      dialogueState: { awaitingConfirmation: true, slots: {}, escalationActive: false },
    };

    const request: OrchestratorRequest = {
      sessionId: 'test-5',
      clientId: 'savanna-bank',
      config: SAVANNA_CONFIG,
      context: contextWithPending,
      userUtterance: 'Yes, please confirm',
      detectedLanguage: 'en-NG',
      languageConfidence: 0.9,
    };

    const response = await orchestrator.process(request);
    expect(response.decision.type).toBe('confirm_action');
    if (response.decision.type === 'confirm_action') {
      expect(response.decision.confirmed).toBe(true);
    }
  });

  test('handles denial in confirmation flow', async () => {
    const contextWithPending: ConversationContext = {
      ...emptyContext('test-6'),
      pendingAction: {
        id: 'action-2',
        sessionId: 'test-6',
        turnId: 'turn-0',
        intentName: 'raise_transfer_limit',
        actionName: 'update_transfer_limit',
        parameters: { account_id: 'ACC-001', new_limit: 100000 },
        status: 'pending',
        createdAt: new Date(),
      },
      dialogueState: { awaitingConfirmation: true, slots: {}, escalationActive: false },
    };

    const request: OrchestratorRequest = {
      sessionId: 'test-6',
      clientId: 'savanna-bank',
      config: SAVANNA_CONFIG,
      context: contextWithPending,
      userUtterance: 'No, cancel it',
      detectedLanguage: 'en-NG',
      languageConfidence: 0.9,
    };

    const response = await orchestrator.process(request);
    expect(response.decision.type).toBe('confirm_action');
    if (response.decision.type === 'confirm_action') {
      expect(response.decision.confirmed).toBe(false);
    }
  });

  test('maintains context across language switch', async () => {
    const ctx = emptyContext('test-7');
    ctx.turns = [
      {
        id: 't1', sessionId: 'test-7', turnIndex: 0, speaker: 'user',
        language: 'en-NG', text: 'What is my balance?', status: 'complete',
        confidence: 0.9, createdAt: new Date(),
      },
      {
        id: 't2', sessionId: 'test-7', turnIndex: 1, speaker: 'ai',
        language: 'en-NG', text: 'Your balance is ₦50,000.', status: 'complete',
        confidence: 0.9, createdAt: new Date(),
      },
    ];

    const request: OrchestratorRequest = {
      sessionId: 'test-7',
      clientId: 'savanna-bank',
      config: SAVANNA_CONFIG,
      context: ctx,
      userUtterance: 'Ẹ ṣé, ṣé owó mi lè kúrò?',
      detectedLanguage: 'yo',
      languageConfidence: 0.8,
    };

    const response = await orchestrator.process(request);
    expect(response.updatedContext.lastLanguage).toBe('yo');
    expect(response.updatedContext.turns).toHaveLength(2);
  });
});
