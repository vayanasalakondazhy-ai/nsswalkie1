import { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { Mic, MicOff, Users, Shield, Radio, LogOut, ChevronRight, Activity, Signal, Battery, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Role = 'admin' | 'user';
interface NSSUser {
  id: string;
  name: string;
  role: Role;
  status: 'idle' | 'speaking';
}

interface IncomingAudio {
  senderId: string;
  senderName: string;
  blob: ArrayBuffer;
  isPrivate: boolean;
}

export default function App() {
  const [user, setUser] = useState<{ name: string; role: Role; serverUrl?: string } | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [userList, setUserList] = useState<NSSUser[]>([]);
  const [targetUser, setTargetUser] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [incomingSpeaker, setIncomingSpeaker] = useState<{ name: string; isPrivate: boolean } | null>(null);
  const [connected, setConnected] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (user) {
      // Intelligently determine the backend URL
      // Priority 1: User explicitly typed a URL in Config
      // Priority 2: VITE_APP_URL from environment (baked in by GitHub Actions)
      // Priority 3: Same origin (if in AI Studio)
      let rawUrl = user.serverUrl || import.meta.env.VITE_APP_URL || '';
      
      // If we are on GitHub Pages and have no VITE_APP_URL, we should NOT go same-origin
      const isOnGitHub = window.location.hostname.includes('github.io');
      const backendUrl = (rawUrl && rawUrl !== window.location.origin)
        ? (rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`).replace(/\/$/, '')
        : (isOnGitHub ? '' : ''); // Fallback for same-origin if not on GitHub

      const socketOptions: any = {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 2000,
        path: '/socket.io'
      };
      
      const newSocket = backendUrl 
        ? io(backendUrl, socketOptions) 
        : io(socketOptions);

      socketRef.current = newSocket;
      setSocket(newSocket);

      newSocket.on('connect', () => {
        console.log('Connected to NSS Comms Cloud');
        setConnected(true);
        newSocket.emit('join', { name: user.name, role: user.role });
      });

      newSocket.on('connect_error', (err) => {
        console.error('Handshake failed:', err.message);
        setConnected(false);
      });

      newSocket.on('user-list', (list: NSSUser[]) => {
        console.log('Received updated volunteer roster:', list.length);
        setUserList(list);
      });

      newSocket.on('audio-stream', async (data: IncomingAudio) => {
        setIncomingSpeaker({ name: data.senderName, isPrivate: data.isPrivate });
        try {
          if (!audioContextRef.current) {
            audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
          }
          const ctx = audioContextRef.current;
          
          if (ctx.state === 'suspended') {
            await ctx.resume();
          }

          // More resilient data conversion
          let audioData: ArrayBuffer;
          if (data.blob instanceof ArrayBuffer) {
            audioData = data.blob;
          } else if ((data.blob as any).buffer instanceof ArrayBuffer) {
            audioData = (data.blob as any).buffer;
          } else if (Array.isArray(data.blob) || (data.blob as any).data) {
            // Handle raw array or Socket.io Buffer object
            const rawData = (data.blob as any).data || data.blob;
            audioData = new Uint8Array(rawData).buffer;
          } else {
            throw new Error('Unsupported audio data format');
          }
          
          const buffer = await ctx.decodeAudioData(audioData.slice(0));
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          source.start(0);
          source.onended = () => {
            setIncomingSpeaker(null);
          };
        } catch (err) {
          console.error('Audio processing failed:', err);
          setIncomingSpeaker(null);
        }
      });

      newSocket.on('disconnect', () => {
        setConnected(false);
      });

      return () => {
        newSocket.disconnect();
      };
    }
  }, [user]);

  const startRecording = useCallback(async () => {
    if (!socketRef.current) return;
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Select best supported MIME type
      const mimeTypes = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac'];
      const supportedMimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type)) || '';
      
      const recorder = new MediaRecorder(stream, supportedMimeType ? { mimeType: supportedMimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        if (chunksRef.current.length > 0 && socketRef.current) {
          const fullBlob = new Blob(chunksRef.current, { type: supportedMimeType || 'audio/wav' });
          const buffer = await fullBlob.arrayBuffer();
          socketRef.current.emit('audio-chunk', {
            blob: buffer,
            targetId: targetUser || undefined
          });
        }
      };

      recorder.start(); 
      setIsRecording(true);
      socketRef.current.emit('speaking-state', true);
    } catch (err) {
      console.error('Handshake failed/Permission denied:', err);
    }
  }, [targetUser]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
      if (socketRef.current) {
        socketRef.current.emit('speaking-state', false);
      }
    }
  }, []);

  if (!user) {
    return <LoginView onJoin={(name, role, serverUrl) => setUser({ name, role, serverUrl })} />;
  }

  return (
    <div className="flex flex-col h-screen bg-bg-dark text-text-main font-sans selection:bg-accent-blue/30 overflow-hidden">
      {/* HEADER */}
      <header className="px-6 py-4 bg-surface border-b border-border-dim flex justify-between items-center z-20 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="font-black tracking-tighter text-accent-blue flex items-center gap-2 text-xl">
             <Radio className="w-6 h-6" /> NSS COMMAND <span className="bg-accent-red text-white px-2 py-0.5 rounded text-xs font-bold tracking-widest">HQ</span>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-8 text-[11px] font-mono tracking-wider">
           <div className="flex items-center gap-2">
              <Signal className="w-3.5 h-3.5 text-accent-blue" />
              <span>NETWORK: <span className="text-white">446.050 MHZ</span></span>
           </div>
           <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-accent-blue" />
              <span>ENCRYPTION: <span className="text-white">AES-256</span></span>
           </div>
           <div className={cn("flex items-center gap-2", connected ? "text-status-green" : "text-accent-red")}>
              <div className={cn("w-2 h-2 rounded-full", connected ? "bg-status-green animate-pulse" : "bg-accent-red")} />
              <span>{connected ? "SYSTEM ONLINE" : "NETWORK OFFLINE"}</span>
           </div>
           <button 
              onClick={() => setUser(null)}
              className="flex items-center gap-2 text-text-dim hover:text-accent-red transition-colors ml-4 uppercase font-bold"
           >
              <LogOut className="w-3.5 h-3.5" /> Logout
           </button>
        </div>
      </header>

      {/* MAIN CONTENT SPLIT */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-[1px] bg-border-dim overflow-hidden">
        
        {/* LEFT PANE: ADMIN CONSOLE / USER DIRECTORY */}
        <section className="bg-bg-dark p-8 flex flex-col gap-6 overflow-hidden">
          <div className="border-l-4 border-accent-blue pl-4">
            <h2 className="text-lg font-bold tracking-tight uppercase">Admin Console</h2>
            <p className="text-xs text-text-dim uppercase tracking-wider font-semibold opacity-70">Coordinator Panel • Unit Monitoring</p>
          </div>

          <button 
            onClick={() => setTargetUser(null)}
            className={cn(
               "flex justify-between items-center p-4 rounded-xl font-bold text-sm transition-all group",
               targetUser === null 
                 ? "bg-accent-blue text-white shadow-[0_0_20px_rgba(37,99,235,0.3)]" 
                 : "bg-surface border border-border-dim text-text-main hover:bg-surface/80"
            )}
          >
            <div className="flex items-center gap-3">
              <Radio className={cn("w-4 h-4", targetUser === null ? "animate-pulse" : "opacity-40")} />
              <span>BROADCAST TO ALL UNITS ({userList.length})</span>
            </div>
            <span className={cn("text-[9px] px-2 py-1 rounded font-mono", targetUser === null ? "bg-black/20" : "bg-black/40 text-text-dim")}>
              PTT [CHANNEL-00]
            </span>
          </button>

          <div className="bg-surface rounded-xl p-4 flex-1 flex flex-col overflow-hidden border border-border-dim/50 shadow-inner">
             <div className="flex justify-between items-center mb-4 px-2">
                <span className="text-[10px] font-bold text-text-dim uppercase tracking-widest flex items-center gap-2">
                   <Users className="w-3.5 h-3.5" /> Volunteer Directory
                </span>
                <span className="text-[9px] bg-bg-dark px-2 py-1 rounded text-accent-blue font-bold border border-accent-blue/10">
                   {userList.length} ONLINE
                </span>
             </div>

             <div className="flex-1 overflow-y-auto space-y-1 pr-2 scrollbar-thin scrollbar-thumb-accent-blue/20">
                <AnimatePresence mode="popLayout">
                  {userList.map(u => {
                    if (u.id === socketRef.current?.id) return null;
                    const isTargeted = targetUser === u.id;
                    return (
                      <motion.div 
                        layout
                        key={u.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                         onClick={() => setTargetUser(u.id)}
                        className={cn(
                          "grid grid-cols-[40px_1fr_80px] items-center p-3 rounded-lg border transition-all cursor-pointer group",
                          isTargeted 
                            ? "bg-accent-blue/10 border-accent-blue/30" 
                            : "border-transparent hover:bg-surface/50"
                        )}
                      >
                         <div className="flex justify-center">
                            <div className={cn(
                              "w-2 h-2 rounded-full",
                              u.status === 'speaking' ? "bg-accent-red animate-ping" : "bg-status-green"
                            )} />
                         </div>
                         <div className="flex flex-col">
                            <span className={cn("text-xs font-bold", isTargeted ? "text-accent-blue" : "text-text-main")}>
                               {u.name}
                            </span>
                            <span className="text-[9px] uppercase tracking-tighter text-text-dim/60 font-semibold italic">
                               {u.role} • UNIT ID: {u.id?.slice(0, 4).toUpperCase()}
                            </span>
                         </div>
                         <div className="flex justify-end">
                            <button className={cn(
                              "text-[9px] px-2 py-1 rounded border font-bold tracking-tighter uppercase transition-colors",
                              isTargeted ? "bg-accent-blue text-white border-accent-blue" : "border-accent-blue/30 text-accent-blue group-hover:bg-accent-blue group-hover:text-white"
                            )}>
                               Talk
                            </button>
                         </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
                {userList.length <= 1 && (
                  <div className="h-full flex flex-col items-center justify-center opacity-20 grayscale text-center p-8">
                     <Signal className="w-12 h-12 mb-4" />
                     <p className="text-sm font-bold uppercase tracking-widest">Scanning frequency...</p>
                     <p className="text-[10px] mt-2">No other active units detected on current channel.</p>
                  </div>
                )}
             </div>
          </div>
        </section>

        {/* RIGHT PANE: USER TERMINAL / WALKIE DEVICE */}
        <section className="bg-bg-dark p-8 flex flex-col gap-6 overflow-hidden">
          <div className="border-l-4 border-accent-blue pl-4">
            <h2 className="text-lg font-bold tracking-tight uppercase">User Terminal</h2>
            <p className="text-xs text-text-dim uppercase tracking-wider font-semibold opacity-70">Unit #{socketRef.current?.id?.slice(0, 3).toUpperCase() || "??? "} • Active Session</p>
          </div>

          <div className="bg-[#27272A] border border-[#3F3F46] rounded-[2.5rem] p-8 shadow-[0_20px_50px_rgba(0,0,0,0.6)] flex-1 flex flex-col relative overflow-hidden max-w-sm mx-auto w-full">
             {/* Realistic Device Screen */}
             <div className="bg-black border-2 border-[#3F3F46] rounded-xl p-5 h-52 flex flex-col justify-between font-mono relative mb-8 shadow-inner">
                <div className="absolute inset-0 bg-[#00FF00]/[0.01] pointer-events-none" />
                <div className="flex justify-between items-center text-[9px] text-status-green/80 font-bold uppercase">
                   <div className="flex items-center gap-2 underline decoration-status-green/20 underline-offset-2">
                     <Radio className="w-2.5 h-2.5" /> CH-01 [HQ]
                   </div>
                   <div className="flex gap-1.5 items-center">
                      <Signal className="w-2.5 h-2.5" />
                      <span>SIG: |||||</span>
                   </div>
                   <div className="flex gap-1.5 items-center">
                      <Battery className="w-2.5 h-2.5" />
                      <span>84%</span>
                   </div>
                </div>

                <div className="text-center">
                   <div className={cn(
                     "text-[13px] font-bold uppercase tracking-widest mb-3",
                     isRecording ? "text-accent-red" : incomingSpeaker ? "text-status-green" : "text-white/20"
                   )}>
                      {isRecording ? "Transmitting to admin..." : incomingSpeaker ? `RECV: ${incomingSpeaker.name.toUpperCase()}` : "Ready / Standby"}
                   </div>
                   
                   {/* Visualization */}
                   <div className="flex items-end justify-center gap-1 h-14">
                      {[...Array(12)].map((_, i) => (
                        <motion.div 
                          key={i}
                          animate={{ 
                            height: (isRecording || incomingSpeaker) ? [8, Math.random() * 45 + 10, 8] : 8 
                          }}
                          transition={{ duration: 0.15, repeat: Infinity, delay: i * 0.03 }}
                          className={cn("w-1.5 rounded-sm", (isRecording || incomingSpeaker) ? "bg-status-green" : "bg-white/10")}
                        />
                      ))}
                   </div>
                </div>

                <div className="flex justify-between items-center text-[8px] text-text-dim/50 uppercase font-black tracking-widest">
                   <span>VOL: 75%</span>
                   <span className="text-white/20">SQL: 02</span>
                   <span>V-SCAN: ON</span>
                </div>
             </div>

             {/* Controls */}
             <div className="flex-1 flex flex-col gap-4">
                <button 
                  onMouseDown={startRecording}
                  onMouseUp={stopRecording}
                  onMouseLeave={stopRecording}
                  onTouchStart={startRecording}
                  onTouchEnd={stopRecording}
                  disabled={!!incomingSpeaker}
                  className={cn(
                    "w-full py-10 rounded-3xl font-black text-2xl uppercase tracking-[0.2em] transition-all text-white border-2",
                    isRecording 
                      ? "bg-gradient-to-b from-accent-red to-[#991B1B] border-[#F87171] shadow-[0_0_30px_rgba(239,68,68,0.4)] translate-y-1" 
                      : incomingSpeaker
                        ? "bg-surface/50 border-border-dim opacity-50 cursor-not-allowed"
                        : "bg-gradient-to-b from-[#3F3F46] to-[#18181B] border-[#52525B] shadow-[0_8px_0_#18181B] active:shadow-none active:translate-y-[8px]"
                  )}
                >
                  {isRecording ? "PTT ON" : "PTT"}
                </button>

                <div className="grid grid-cols-3 gap-2">
                   <div className="bg-surface border border-border-dim rounded-lg p-3 text-center flex flex-col gap-1 items-center">
                      <span className="text-[8px] text-text-dim font-bold uppercase tracking-widest">Channel</span>
                      <span className="text-[10px] font-black uppercase">General</span>
                   </div>
                   <div className="bg-surface border border-border-dim rounded-lg p-3 text-center flex flex-col gap-1 items-center">
                      <span className="text-[8px] text-text-dim font-bold uppercase tracking-widest">Mode</span>
                      <span className="text-[10px] font-black uppercase tracking-tighter">VOX-OFF</span>
                   </div>
                   <div className="bg-accent-red border border-accent-red/50 rounded-lg p-3 text-center flex flex-col gap-1 items-center text-white">
                      <AlertTriangle className="w-2.5 h-2.5 mb-0.5" />
                      <span className="text-[9px] font-black italic">SOS</span>
                   </div>
                </div>
             </div>

             <div className="mt-8 text-center">
                <span className="text-[9px] font-mono text-text-dim/40 uppercase tracking-[0.3em] font-black">
                   Station ID: NSS-UNIT-{socketRef.current?.id?.slice(0, 4).toUpperCase() || "MAH-042"}
                </span>
             </div>
          </div>
        </section>
      </main>

      {/* FOOTER */}
      <footer className="bg-surface px-6 py-2 border-t border-border-dim text-[10px] text-text-dim/60 flex justify-between items-center z-20">
        <div className="flex items-center gap-1.5 uppercase tracking-wider font-semibold">
           © 2026 National Service Scheme - <span className="text-white/40">Integrated Comms System</span>
        </div>
        <div className="flex gap-6 uppercase font-mono tracking-widest">
           <span>LAT: 19.0760 N</span>
           <span>LNG: 72.8777 E</span>
           <span className="text-accent-blue font-bold">V 1.0.4 - STABLE</span>
        </div>
      </footer>
    </div>
  );
}

function LoginView({ onJoin }: { onJoin: (name: string, role: Role, customUrl?: string) => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('user');
  // Initialize with VITE_APP_URL or fallback to a known HQ if on GitHub
  const defaultUrl = import.meta.env.VITE_APP_URL || (window.location.hostname.includes('github.io') ? 'https://ais-pre-inf7ds2nx7abuaxzkrdiuw-708795681477.asia-southeast1.run.app' : '');
  const [serverUrl, setServerUrl] = useState(defaultUrl);
  const [showConfig, setShowConfig] = useState(false);
  const [testResult, setTestResult] = useState<'idle' | 'checking' | 'success' | 'failed'>('idle');

  const testConnection = async () => {
    if (!serverUrl) return;
    setTestResult('checking');
    try {
      let url = serverUrl.trim();
      if (!url.startsWith('http')) url = `https://${url}`;
      url = url.replace(/\/$/, '');
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      // Try a simple GET first
      const response = await fetch(`${url}/api/health`, { 
        method: 'GET',
        mode: 'cors',
        signal: controller.signal
      }).catch(() => null);
      
      clearTimeout(timeoutId);

      if (response && response.ok) {
        setTestResult('success');
      } else {
        // Fallback: try an opaque request just to check reachability
        const pingResponse = await fetch(`${url}/api/health`, { 
          mode: 'no-cors',
          method: 'GET'
        }).catch(() => null);
        
        if (pingResponse) {
           setTestResult('success'); // Opaque success is enough for us to try Socket.io
        } else {
           setTestResult('failed');
        }
      }
    } catch (e) {
      setTestResult('failed');
    }
  };

  return (
    <div className="min-h-screen bg-bg-dark flex items-center justify-center p-6 font-sans">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md bg-surface border border-border-dim rounded-3xl p-10 shadow-2xl relative overflow-hidden"
      >
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-accent-blue to-transparent opacity-50" />
        
        <div className="flex flex-col items-center gap-4 mb-10 text-center">
           <div className="w-16 h-16 bg-accent-blue rounded-2xl flex items-center justify-center text-white shadow-[0_0_30px_rgba(37,99,235,0.4)]">
             <Radio className="w-8 h-8" />
           </div>
           <div>
              <h1 className="text-2xl font-black tracking-tight text-white uppercase italic">NSS VOX <span className="text-accent-blue">TRX</span></h1>
              <p className="text-[10px] text-text-dim font-bold uppercase tracking-[0.3em] mt-1">Multi-Channel Radio Terminal</p>
           </div>
        </div>

        <div className="space-y-8">
           <div className="space-y-3">
              <label className="block text-[9px] font-black uppercase tracking-[0.2em] text-accent-blue flex justify-between">
                Volunteer Identification
                <button 
                  onClick={() => setShowConfig(!showConfig)}
                  className="text-[8px] opacity-40 hover:opacity-100 flex items-center gap-1"
                >
                  <Activity className="w-2.5 h-2.5" /> {showConfig ? 'HIDE CONFIG' : 'SERVER CONFIG'}
                </button>
              </label>
              <input 
                 type="text"
                 value={name}
                 onChange={(e) => setName(e.target.value)}
                 placeholder="NAME / UNIT ID"
                 className="w-full px-5 py-4 bg-bg-dark rounded-xl border-2 border-border-dim/50 focus:border-accent-blue text-white outline-none transition-all placeholder:text-white/10 font-mono text-sm uppercase tracking-widest font-bold"
              />
           </div>

           {showConfig && (
             <motion.div 
               initial={{ height: 0, opacity: 0 }}
               animate={{ height: 'auto', opacity: 1 }}
               className="space-y-3 overflow-hidden bg-black/20 p-4 rounded-xl border border-border-dim/20"
             >
                <div className="flex justify-between items-center mb-1">
                  <label className="block text-[9px] font-black uppercase tracking-[0.2em] text-accent-blue">Transmission Gateway</label>
                  {testResult === 'success' && <span className="text-[8px] text-status-green font-bold">LINK READY</span>}
                  {testResult === 'failed' && <span className="text-[8px] text-accent-red font-bold">LINK FAILED</span>}
                </div>
                <div className="flex gap-2">
                  <input 
                     type="text"
                     value={serverUrl}
                     onChange={(e) => setServerUrl(e.target.value)}
                     placeholder="https://comm-server.run.app"
                     className="flex-1 px-3 py-2 bg-black/40 rounded-lg border border-border-dim/30 text-[10px] text-text-dim font-mono outline-none focus:border-accent-blue"
                  />
                  <button 
                    onClick={testConnection}
                    disabled={testResult === 'checking'}
                    className={cn(
                      "px-3 rounded-lg text-[9px] font-bold uppercase transition-all whitespace-nowrap border",
                      testResult === 'success' ? "border-status-green text-status-green" : "border-accent-blue text-accent-blue hover:bg-accent-blue hover:text-white"
                    )}
                  >
                    {testResult === 'checking' ? '...' : 'TEST'}
                  </button>
                </div>
                <p className="text-[8px] text-text-dim font-medium italic opacity-50">
                  * Must be a secure HTTPS URL for mobile audio features.
                </p>
             </motion.div>
           )}

           <div className="space-y-3">
              <label className="block text-[9px] font-black uppercase tracking-[0.2em] text-accent-blue">Authorization level</label>
              <div className="grid grid-cols-2 gap-4">
                 <button 
                    onClick={() => setRole('user')}
                    className={cn(
                      "flex flex-col items-center gap-3 p-5 rounded-2xl border-2 transition-all",
                      role === 'user' 
                        ? "border-accent-blue bg-accent-blue/10 text-white shadow-lg" 
                        : "border-border-dim/50 bg-bg-dark text-text-dim hover:border-text-dim/30"
                    )}
                 >
                    <Users className="w-6 h-6" />
                    <span className="text-[10px] font-black uppercase tracking-widest">Operator</span>
                 </button>
                 <button 
                    onClick={() => setRole('admin')}
                    className={cn(
                      "flex flex-col items-center gap-3 p-5 rounded-2xl border-2 transition-all",
                      role === 'admin' 
                        ? "border-accent-blue bg-accent-blue/10 text-white shadow-lg" 
                        : "border-border-dim/50 bg-bg-dark text-text-dim hover:border-text-dim/30"
                    )}
                 >
                    <Shield className="w-6 h-6" />
                    <span className="text-[10px] font-black uppercase tracking-widest">HQ Command</span>
                 </button>
              </div>
           </div>

           <button 
              onClick={() => name && onJoin(name, role, serverUrl)}
              disabled={!name}
              className="group relative w-full overflow-hidden rounded-2xl bg-accent-blue p-5 font-black uppercase tracking-[0.3em] text-white shadow-[0_10px_30px_rgba(37,99,235,0.4)] transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-30 disabled:grayscale disabled:scale-100 disabled:pointer-events-none"
           >
              <div className="relative z-10 flex items-center justify-center gap-3">
                 Establish Link <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
              </div>
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
           </button>
        </div>
        
        <div className="mt-10 text-center opacity-20 hover:opacity-100 transition-opacity">
           <p className="text-[8px] font-mono tracking-widest font-black uppercase">Secure Transceiver Protocol v1.4.2</p>
        </div>
      </motion.div>
    </div>
  );
}
