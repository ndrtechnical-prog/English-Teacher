
import React, { useState, useRef, useCallback, useEffect } from 'react';
// Fix: Removed 'LiveSession' from imports as it's not an exported member.
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from '@google/genai';
import type { TranscriptEntry, Status } from './types';
import { encode, decode, decodeAudioData } from './utils/audio';
import MicIcon from './components/MicIcon';
import StopIcon from './components/StopIcon';
import SpinnerIcon from './components/SpinnerIcon';

const App: React.FC = () => {
  const [status, setStatus] = useState<Status>('idle');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>('');

  // Fix: Changed type from LiveSession to any as LiveSession is not exported.
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);

  const currentInputTranscriptionRef = useRef('');
  const currentOutputTranscriptionRef = useRef('');

  const stopAllPlayback = () => {
    if (sourcesRef.current) {
        for (const source of sourcesRef.current.values()) {
            source.stop();
            sourcesRef.current.delete(source);
        }
        nextStartTimeRef.current = 0;
    }
  };

  const cleanUpAudio = useCallback(() => {
    stopAllPlayback();

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }

    if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
      inputAudioContextRef.current.close().catch(console.error);
    }
    inputAudioContextRef.current = null;
    
    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
      outputAudioContextRef.current.close().catch(console.error);
    }
    outputAudioContextRef.current = null;

  }, []);

  const stopConversation = useCallback(async () => {
    setStatus('idle');
    if (sessionPromiseRef.current) {
      try {
        const session = await sessionPromiseRef.current;
        session.close();
      } catch (e) {
        console.error("Error closing session:", e);
      }
      sessionPromiseRef.current = null;
    }
    cleanUpAudio();
  }, [cleanUpAudio]);


  const startConversation = useCallback(async () => {
    setTranscript([]);
    setErrorMessage('');
    setStatus('connecting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      
      // Fix: Handle vendor prefix for webkitAudioContext for cross-browser compatibility.
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      inputAudioContextRef.current = new AudioContext({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: 'You are a friendly and patient English teacher. Your student is learning English as a second language. Keep your responses concise, clear, and encouraging. Correct mistakes gently and explain them simply. Ask questions to keep the conversation going.',
        },
        callbacks: {
          onopen: () => {
            setStatus('listening');
            const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;

            // Fix: Refactored to follow Gemini API guidelines for sending audio data.
            // Using the local sessionPromise avoids race conditions and stale closures.
            // The blob creation is now more performant.
            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }

              const pcmBlob: Blob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle audio output
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              setStatus('speaking');
              const outputAudioContext = outputAudioContextRef.current;
              if (outputAudioContext) {
                  nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContext.currentTime);
                  const audioBuffer = await decodeAudioData(decode(audioData), outputAudioContext, 24000, 1);
                  const source = outputAudioContext.createBufferSource();
                  source.buffer = audioBuffer;
                  source.connect(outputAudioContext.destination);
                  source.addEventListener('ended', () => {
                      sourcesRef.current.delete(source);
                      if (sourcesRef.current.size === 0) {
                          setStatus('listening');
                      }
                  });
                  source.start(nextStartTimeRef.current);
                  nextStartTimeRef.current += audioBuffer.duration;
                  sourcesRef.current.add(source);
              }
            }

            // Handle transcriptions
            if (message.serverContent?.inputTranscription) {
              currentInputTranscriptionRef.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscriptionRef.current += message.serverContent.outputTranscription.text;
            }
            if (message.serverContent?.turnComplete) {
              const fullInput = currentInputTranscriptionRef.current.trim();
              const fullOutput = currentOutputTranscriptionRef.current.trim();
              
              if(fullInput) {
                setTranscript(prev => [...prev, { speaker: 'You', text: fullInput }]);
              }
              if(fullOutput) {
                setTranscript(prev => [...prev, { speaker: 'Teacher', text: fullOutput }]);
              }

              currentInputTranscriptionRef.current = '';
              currentOutputTranscriptionRef.current = '';
            }

            if (message.serverContent?.interrupted) {
              stopAllPlayback();
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error("Session error:", e);
            setErrorMessage(`An error occurred: ${e.message}. Please try again.`);
            setStatus('error');
            stopConversation();
          },
          onclose: () => {
            console.log("Session closed.");
            cleanUpAudio();
            if(status !== 'idle') {
              setStatus('idle');
            }
          },
        },
      });
      sessionPromiseRef.current = sessionPromise;
    } catch (err) {
      console.error('Failed to start conversation:', err);
      const error = err as Error;
      setErrorMessage(`Failed to start: ${error.message}. Make sure microphone access is allowed.`);
      setStatus('error');
    }
  }, [stopConversation, cleanUpAudio, status]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  useEffect(() => {
    return () => {
      stopConversation();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getStatusText = () => {
    switch (status) {
      case 'connecting':
        return 'Connecting to the classroom...';
      case 'listening':
        return 'Listening... Speak now!';
      case 'speaking':
        return 'Teacher is speaking...';
      case 'error':
        return `Error: ${errorMessage}`;
      default:
        return 'Press the microphone to start your lesson.';
    }
  };

  const renderControlButton = () => {
    if (status === 'idle' || status === 'error') {
      return (
        <button
          onClick={startConversation}
          className="w-20 h-20 bg-blue-600 rounded-full flex items-center justify-center text-white hover:bg-blue-700 transition-all duration-200 shadow-lg focus:outline-none focus:ring-4 focus:ring-blue-500/50"
          aria-label="Start conversation"
        >
          <MicIcon className="w-10 h-10" />
        </button>
      );
    }

    if (status === 'connecting') {
      return (
         <div className="w-20 h-20 bg-gray-600 rounded-full flex items-center justify-center text-white transition-all duration-200 shadow-lg">
          <SpinnerIcon className="w-10 h-10" />
        </div>
      );
    }
    
    return (
      <button
        onClick={stopConversation}
        className="w-20 h-20 bg-red-600 rounded-full flex items-center justify-center text-white hover:bg-red-700 transition-all duration-200 shadow-lg focus:outline-none focus:ring-4 focus:ring-red-500/50"
        aria-label="Stop conversation"
      >
        <StopIcon className="w-10 h-10" />
      </button>
    );
  };
  
  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-between p-4 font-sans">
      <header className="w-full max-w-4xl text-center py-4">
        <h1 className="text-4xl md:text-5xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-teal-300">
          Gemini English Tutor
        </h1>
        <p className="text-slate-400 mt-2">Practice your English by having a real conversation with an AI tutor.</p>
      </header>

      <main className="w-full max-w-4xl flex-grow bg-slate-800/50 rounded-xl shadow-2xl flex flex-col my-4 overflow-hidden">
        <div className="flex-grow p-4 md:p-6 overflow-y-auto space-y-4">
          {transcript.length === 0 && (
            <div className="flex items-center justify-center h-full text-slate-500">
              Your conversation will appear here.
            </div>
          )}
          {transcript.map((entry, index) => (
            <div key={index} className={`flex ${entry.speaker === 'You' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-xs md:max-w-md lg:max-w-xl p-3 rounded-2xl ${entry.speaker === 'You' ? 'bg-blue-600 text-white rounded-br-lg' : 'bg-slate-700 text-slate-200 rounded-bl-lg'}`}>
                <p className="font-bold text-sm mb-1">{entry.speaker}</p>
                <p>{entry.text}</p>
              </div>
            </div>
          ))}
          <div ref={transcriptEndRef} />
        </div>
      </main>

      <footer className="w-full max-w-4xl flex flex-col items-center justify-center py-4">
        <div className="mb-4">
          {renderControlButton()}
        </div>
        <p className={`text-center transition-opacity duration-300 ${status === 'error' ? 'text-red-400' : 'text-slate-400'}`}>
          {getStatusText()}
        </p>
      </footer>
    </div>
  );
};

export default App;
