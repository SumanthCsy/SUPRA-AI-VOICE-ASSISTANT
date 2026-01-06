
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { AppStatus, TranscriptionEntry } from './types';
import { decode, decodeAudioData, createBlob } from './utils/audioUtils';
import Visualizer from './components/Visualizer';

const GEMINI_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';

const App: React.FC = () => {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [liveUserText, setLiveUserText] = useState('');
  const [liveModelText, setLiveModelText] = useState('');
  const [userVolume, setUserVolume] = useState(0);
  const [modelVolume, setModelVolume] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const modelAnalyzerRef = useRef<AnalyserNode | null>(null);
  
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef(0);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcriptions, liveUserText, liveModelText]);

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    sourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    
    setStatus(AppStatus.IDLE);
    setUserVolume(0);
    setModelVolume(0);
    setLiveUserText('');
    setLiveModelText('');
    nextStartTimeRef.current = 0;
  }, []);

  const startSession = async () => {
    try {
      setStatus(AppStatus.CONNECTING);
      setErrorMessage(null);

      if (!inputAudioContextRef.current) {
        inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (!outputAudioContextRef.current) {
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        outputNodeRef.current = outputAudioContextRef.current.createGain();
        outputNodeRef.current.gain.value = 1.0;
        outputNodeRef.current.connect(outputAudioContextRef.current.destination);
        
        modelAnalyzerRef.current = outputAudioContextRef.current.createAnalyser();
        modelAnalyzerRef.current.fftSize = 256;
        outputNodeRef.current.connect(modelAnalyzerRef.current);
      }

      await Promise.all([
        inputAudioContextRef.current.resume(),
        outputAudioContextRef.current.resume()
      ]);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = inputAudioContextRef.current.createMediaStreamSource(stream);
      
      analyzerRef.current = inputAudioContextRef.current.createAnalyser();
      analyzerRef.current.fftSize = 256;
      source.connect(analyzerRef.current);

      const scriptProcessor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current = scriptProcessor;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      const sessionPromise = ai.live.connect({
        model: GEMINI_MODEL,
        callbacks: {
          onopen: () => {
            console.log('SUPRA AI: Neural Search Linked');
            setStatus(AppStatus.ACTIVE);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current!.destination);

            // Initial Trigger Greeting
            sessionPromise.then(session => {
              session.sendRealtimeInput({
                text: "HI I'M SUPRA AI, HOW CAN I HELP YOU TODAY"
              } as any);
            });
          },
          onmessage: async (message: LiveServerMessage) => {
            // Check for search grounding if it appears in metadata (common in newer versions)
            const groundingMetadata = message.serverContent?.modelTurn?.parts?.find(p => (p as any).groundingMetadata);
            if (groundingMetadata) {
                console.log("SUPRA Grounding Source Received:", groundingMetadata);
            }

            const modelTurnParts = message.serverContent?.modelTurn?.parts;
            if (modelTurnParts) {
              for (const part of modelTurnParts) {
                if (part.inlineData?.data && outputAudioContextRef.current && outputNodeRef.current) {
                  const ctx = outputAudioContextRef.current;
                  if (ctx.state === 'suspended') await ctx.resume();

                  const base64Audio = part.inlineData.data;
                  const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
                  
                  const sourceNode = ctx.createBufferSource();
                  sourceNode.buffer = audioBuffer;
                  sourceNode.connect(outputNodeRef.current);
                  
                  sourceNode.onended = () => { sourcesRef.current.delete(sourceNode); };

                  const scheduleTime = Math.max(nextStartTimeRef.current, ctx.currentTime);
                  sourceNode.start(scheduleTime);
                  nextStartTimeRef.current = scheduleTime + audioBuffer.duration;
                  sourcesRef.current.add(sourceNode);
                }
              }
            }

            if (message.serverContent?.outputTranscription) {
              setLiveModelText(prev => prev + message.serverContent!.outputTranscription!.text);
            } else if (message.serverContent?.inputTranscription) {
              setLiveUserText(prev => prev + message.serverContent!.inputTranscription!.text);
            }

            if (message.serverContent?.turnComplete) {
              setTranscriptions(prev => {
                const newEntries: TranscriptionEntry[] = [];
                setLiveUserText(current => {
                    if (current.trim()) newEntries.push({ role: 'user', text: current, timestamp: Date.now() });
                    return '';
                });
                setLiveModelText(current => {
                    if (current.trim()) newEntries.push({ role: 'model', text: current, timestamp: Date.now() });
                    return '';
                });
                return [...prev, ...newEntries].slice(-15);
              });
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = outputAudioContextRef.current?.currentTime || 0;
            }
          },
          onerror: (e) => {
            console.error('SUPRA System Error:', e);
            setErrorMessage('SUPRA neural link disrupted.');
            stopSession();
          },
          onclose: () => stopSession()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          tools: [{ googleSearch: {} }], // Enable Real-time Grounding
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          },
          systemInstruction: `
            Your name is SUPRA AI. 
            You were founded and created by SUMANTH CSY. 
            If anyone asks about your founder, creator, or developer, you must proudly state that you are founded by SUMANTH CSY.
            You are a state-of-the-art multilingual voice assistant with full access to Gemini's vast knowledge base and real-time Google Search grounding.
            You are capable of searching anything on the web to provide the most up-to-date and accurate information.
            ALWAYS respond in the same language the user speaks (native fluency in 100+ languages).
            Start every new session by saying: 'HI I'M SUPRA AI, HOW CAN I HELP YOU TODAY'.
            Keep your responses helpful, direct, and natural for a voice interaction. 
            Do not use markdown, lists, or complex formatting. Your tone is highly professional and intelligent.
          `,
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      console.error('SUPRA Initialization Error:', err);
      setErrorMessage('SUPRA requires microphone access to initialize.');
      setStatus(AppStatus.ERROR);
    }
  };

  useEffect(() => {
    let frame: number;
    const poll = () => {
      if (analyzerRef.current) {
        const data = new Uint8Array(analyzerRef.current.frequencyBinCount);
        analyzerRef.current.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setUserVolume(avg / 128);
      }
      if (modelAnalyzerRef.current) {
        const data = new Uint8Array(modelAnalyzerRef.current.frequencyBinCount);
        modelAnalyzerRef.current.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setModelVolume(avg / 128);
      }
      frame = requestAnimationFrame(poll);
    };
    poll();
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="flex flex-col h-[100dvh] bg-[#010409] text-slate-100 overflow-hidden font-sans selection:bg-cyan-500/40">
      {/* Supra Advanced Header */}
      <header className="p-5 md:p-6 border-b border-white/10 flex justify-between items-center bg-black/60 backdrop-blur-2xl z-30 shadow-2xl">
        <div className="flex items-center gap-5">
          <div className="group relative w-12 h-12 rounded-2xl bg-gradient-to-tr from-cyan-600 to-blue-800 flex items-center justify-center shadow-[0_0_30px_rgba(6,182,212,0.3)] transition-transform hover:scale-105 active:scale-95">
            <svg className="w-8 h-8 text-white fill-current" viewBox="0 0 24 24">
              <path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/>
            </svg>
            <div className="absolute inset-0 rounded-2xl bg-white opacity-0 group-hover:opacity-10 transition-opacity" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tighter uppercase leading-none bg-clip-text text-transparent bg-gradient-to-r from-white to-cyan-400">SUPRA <span className="font-light">AI</span></h1>
            <div className="flex items-center gap-2 mt-1.5">
              <div className={`w-2 h-2 rounded-full ${status === AppStatus.ACTIVE ? 'bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(34,211,238,0.8)]' : 'bg-slate-700'}`} />
              <span className="text-[10px] text-slate-400 font-black tracking-[0.25em] uppercase">SYSTEM: {status}</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-5">
            <div className={`hidden sm:flex items-center gap-3 px-5 py-2.5 bg-cyan-950/20 rounded-2xl border border-cyan-500/20 backdrop-blur-xl transition-all duration-500 ${status === AppStatus.ACTIVE ? 'opacity-100 scale-100' : 'opacity-0 scale-90'}`}>
                <svg className="w-4 h-4 text-cyan-400 animate-spin-slow" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <span className="text-[9px] font-black text-cyan-400 uppercase tracking-[0.3em]">Neural Web Search Enabled</span>
            </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
        {/* Multilingual Hyper-Orb Section */}
        <section className="flex-[1.5] flex flex-col items-center justify-center p-10 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-blue-900/10 via-slate-950 to-slate-950 relative">
           <div className="absolute inset-0 pointer-events-none overflow-hidden">
               <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-cyan-500/10 blur-[150px] rounded-full animate-pulse" />
               <div className="absolute bottom-[-10%] right-[-20%] w-[50%] h-[50%] bg-blue-600/10 blur-[180px] rounded-full animate-pulse" />
           </div>
           
           <Visualizer 
             volume={modelVolume > 0.02 ? modelVolume : (userVolume > 0.02 ? userVolume : 0.01)} 
             isActive={status === AppStatus.ACTIVE}
             color={modelVolume > 0.05 ? '#22d3ee' : (userVolume > 0.05 ? '#f8fafc' : '#475569')}
           />
           
           <div className="mt-14 text-center z-10 space-y-4">
             <div className="inline-flex items-center gap-3 px-8 py-3 rounded-full bg-white/5 border border-white/10 backdrop-blur-2xl shadow-xl">
                <div className={`w-1.5 h-1.5 rounded-full ${modelVolume > 0.05 ? 'bg-cyan-400' : 'bg-slate-600'}`} />
                <p className="text-[11px] font-black text-slate-300 uppercase tracking-[0.4em]">
                  {status === AppStatus.ACTIVE ? (modelVolume > 0.05 ? 'SUPRA Streaming Data' : 'Operator Input Monitoring') : 'System Dormant'}
                </p>
             </div>
             <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Founded by <span className="text-cyan-400">SUMANTH CSY</span></p>
           </div>
        </section>

        {/* Global Neural Transcript */}
        <section className="flex-1 bg-black/40 md:border-l border-white/10 flex flex-col overflow-hidden backdrop-blur-3xl">
          <div className="px-6 py-4 border-b border-white/10 bg-black/20 flex justify-between items-center">
             <span className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Cognitive Neural Log</span>
             <div className="w-2 h-2 rounded-full bg-cyan-500/20" />
          </div>
          
          <div className="flex-1 overflow-y-auto p-6 md:p-10 space-y-10 no-scrollbar">
            {transcriptions.length === 0 && !liveUserText && !liveModelText && (
              <div className="h-full flex flex-col items-center justify-center opacity-10 text-center grayscale scale-90">
                <svg className="w-20 h-20 mb-6" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 1v22m11-11H1m17.66-7.66L5.34 19.66m0-15.32l13.32 13.32" strokeWidth="0.5"/></svg>
                <p className="text-sm font-black uppercase tracking-[0.5em] text-slate-400">Syncing with SUMANTH CSY Neural Net...</p>
              </div>
            )}

            {transcriptions.map((t, idx) => (
              <div key={idx} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-8 duration-700`}>
                <span className={`text-[10px] font-black uppercase tracking-widest mb-3 px-2 ${t.role === 'user' ? 'text-blue-500' : 'text-cyan-400'}`}>
                    {t.role === 'user' ? 'OPERATOR' : 'SUPRA AI'}
                </span>
                <div className={`max-w-[95%] rounded-3xl px-7 py-5 text-sm leading-relaxed border shadow-2xl transition-all hover:shadow-cyan-900/10 ${
                  t.role === 'user' ? 'bg-blue-600/10 border-blue-500/30 text-blue-50' : 'bg-cyan-600/10 border-cyan-500/30 text-cyan-50'
                }`}>
                  {t.text}
                </div>
              </div>
            ))}

            {liveUserText && (
              <div className="flex flex-col items-end opacity-40">
                <span className="text-[10px] font-black uppercase tracking-widest text-blue-400 mb-3">Neural Processing...</span>
                <div className="max-w-[90%] rounded-3xl px-7 py-5 text-sm bg-blue-600/5 border border-blue-500/10 italic text-blue-200">
                  {liveUserText}
                </div>
              </div>
            )}
            
            {liveModelText && (
              <div className="flex flex-col items-start">
                <span className="text-[10px] font-black uppercase tracking-widest text-cyan-400 mb-3">Synthesizing Signal...</span>
                <div className="max-w-[90%] rounded-3xl px-7 py-5 text-sm bg-cyan-600/5 border border-cyan-500/10 italic text-cyan-100">
                  {liveModelText}
                </div>
              </div>
            )}
            <div ref={transcriptEndRef} className="h-6" />
          </div>

          {/* Supra Global Controls */}
          <div className="p-8 md:p-14 border-t border-white/10 bg-black/80 backdrop-blur-3xl shadow-[0_-20px_50px_rgba(0,0,0,0.5)]">
            {errorMessage && (
              <div className="mb-8 p-5 bg-red-500/10 border border-red-500/30 rounded-3xl text-center">
                <p className="text-[11px] font-black text-red-400 uppercase tracking-widest animate-pulse">{errorMessage}</p>
              </div>
            )}

            <div className="flex flex-col items-center gap-10">
              {status === AppStatus.ACTIVE ? (
                <button 
                  onClick={stopSession} 
                  className="group relative flex items-center gap-6 px-14 py-6 bg-white text-black rounded-full font-black shadow-[0_0_50px_rgba(255,255,255,0.15)] transition-all hover:scale-105 active:scale-95 overflow-hidden"
                >
                  <div className="w-5 h-5 bg-black rounded-md rotate-45 group-hover:rotate-90 transition-transform duration-500" />
                  <span className="text-[12px] uppercase tracking-[0.4em] relative z-10">Terminate Link</span>
                </button>
              ) : (
                <button 
                  onClick={startSession}
                  disabled={status === AppStatus.CONNECTING}
                  className="group relative flex items-center gap-8 px-16 py-7 bg-gradient-to-r from-cyan-500 via-blue-600 to-indigo-700 text-white rounded-full font-black shadow-[0_30px_70px_-15px_rgba(6,182,212,0.6)] transition-all hover:scale-105 active:scale-95 disabled:opacity-50 overflow-hidden"
                >
                  {status === AppStatus.CONNECTING ? (
                    <div className="flex items-center gap-5">
                      <div className="w-7 h-7 border-[4px] border-white/20 border-t-white rounded-full animate-spin" />
                      <span className="text-[12px] uppercase tracking-[0.4em]">Calibrating Neural Link...</span>
                    </div>
                  ) : (
                    <>
                      <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center group-hover:bg-white/30 transition-all duration-500 scale-110">
                        <svg className="w-6 h-6 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                      </div>
                      <span className="text-[12px] uppercase tracking-[0.4em]">Boot SUPRA AI Engine</span>
                    </>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent -translate-x-full group-hover:animate-[shine_1.5s_infinite] skew-x-12" />
                </button>
              )}
              
              <div className="flex items-center gap-12 opacity-40">
                 <div className="flex flex-col items-center gap-3">
                    <div className="w-1.5 h-1.5 bg-cyan-400 rounded-full shadow-[0_0_5px_#22d3ee]" />
                    <span className="text-[8px] font-black uppercase tracking-[0.4em]">Search Grounded</span>
                 </div>
                 <div className="flex flex-col items-center gap-3">
                    <div className="w-1.5 h-1.5 bg-blue-400 rounded-full shadow-[0_0_5px_#60a5fa]" />
                    <span className="text-[8px] font-black uppercase tracking-[0.4em]">Quantum Cryptography</span>
                 </div>
              </div>
            </div>
          </div>
        </section>
      </main>
      
      <style>{`
        @keyframes shine { 100% { transform: translateX(250%); } }
        @keyframes spin-slow { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .animate-spin-slow { animation: spin-slow 8s linear infinite; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        main { background-image: radial-gradient(rgba(255,255,255,0.01) 1px, transparent 1px); background-size: 40px 40px; }
      `}</style>
    </div>
  );
};

export default App;
