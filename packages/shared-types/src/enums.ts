export type LanguageCode = 'en-NG' | 'pcm' | 'yo' | 'ig' | 'ha';

export type SpeakerRole = 'ai' | 'user';

export type SessionPhase = 'idle' | 'connecting' | 'active' | 'ended' | 'escalated';

export type TurnStatus = 'transcribing' | 'complete' | 'error';

export type EscalationReason =
  | 'low_confidence'
  | 'caller_request'
  | 'out_of_scope'
  | 'action_failure'
  | 'timeout';

export type ActionStatus = 'pending' | 'confirmed' | 'executed' | 'failed' | 'denied';

export const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  'en-NG': 'English (NG)',
  'pcm': 'Pidgin',
  'yo': 'Yorùbá',
  'ig': 'Igbo',
  'ha': 'Hausa',
};

export const ALL_LANGUAGES: LanguageCode[] = ['en-NG', 'pcm', 'yo', 'ig', 'ha'];
