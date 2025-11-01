
export interface TranscriptEntry {
  speaker: 'You' | 'Teacher';
  text: string;
}

export type Status = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';
