"use client";

import React, { useCallback, useEffect, useState } from 'react';
import ControlsWindow, { ControlsLauncherIcon, GestureAction } from './ControlsWindow';
import { VideoSection } from './sections/VideoSection';
import { PlaygroundProvider, usePlayground } from '@/contexts/PlaygroundContext';
import { useConfig } from '@/hooks/useConfig';
import { 
  useLocalParticipant, 
  useConnectionState, 
  useRoomContext,
  useVoiceAssistant, 
  useTracks,
} from '@livekit/components-react';
import { ConnectionState, RoomEvent, Track } from 'livekit-client';

interface ChatMessage {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  timestamp: number;
}

interface MicrophoneOption {
  deviceId: string;
  label: string;
}

/**
 * Props for the Playground component
 */
export interface PlaygroundProps {
  /** Auto-connect when component loads */
  autoConnect?: boolean;
  /** Callback when connect/disconnect is clicked */
  onConnect: (connect: boolean) => void;
}

/**
 * Loading screen component with progress bar and particle effects
 */
const LoadingScreen = ({ progress }: { progress: number }) => {
  return (
    <div className="absolute inset-0 bg-black flex flex-col items-center justify-center z-50 overflow-hidden">
      {/* Particle effects background */}
      <div className="absolute inset-0">
        {[...Array(50)].map((_, i) => (
          <div
            key={i}
            className="absolute w-1 h-1 bg-blue-400/30 rounded-full animate-float"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              animationDelay: `${Math.random() * 3}s`,
              animationDuration: `${3 + Math.random() * 2}s`,
            }}
          />
        ))}
      </div>
      
      {/* Progress bar */}
      <div className="w-96 h-1 bg-gray-900 rounded-full overflow-hidden relative z-10">
        <div 
          className="h-full bg-gradient-to-r from-blue-500 via-blue-400 to-cyan-400 transition-all duration-1000 ease-out shadow-lg"
          style={{ width: `${progress}%` }}
        />
        {/* Glowing effect */}
        <div 
          className="absolute top-0 h-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-all duration-1000 ease-out"
          style={{ 
            width: '20%',
            left: `${Math.max(0, progress - 10)}%`,
            opacity: progress > 0 ? 1 : 0
          }}
        />
      </div>
    </div>
  );
};

/**
 * PlaygroundPresenter component handles the UI rendering with context-provided state
 */
const PlaygroundPresenter = ({ onDisconnect }: { onDisconnect: () => void }) => {
  const { config } = useConfig();
  const { 
    // State - only keep essential camera/mic states
    isCameraEnabled,
    isMicEnabled,
    isAudioMuted,
    
    // Actions - only keep essential actions
    toggleCamera,
    toggleMicrophone,
    toggleAudio,
  } = usePlayground();
  
  const roomState = useConnectionState();
  const room = useRoomContext();
  const voiceAssistant = useVoiceAssistant();
  const { localParticipant } = useLocalParticipant();
  const [isControlPopupOpen, setIsControlPopupOpen] = useState(false);
  const [microphoneDevices, setMicrophoneDevices] = useState<MicrophoneOption[]>([]);
  const [selectedMicrophoneDeviceId, setSelectedMicrophoneDeviceId] = useState('');
  const closeControls = useCallback(() => {
    setIsControlPopupOpen(false);
  }, []);
  const triggerGesture = useCallback(async (gesture: GestureAction) => {
    const avatarIdentities = Array.from(room.remoteParticipants.keys()).filter((identity) =>
      identity.startsWith('bithuman-avatar')
    );

    if (!localParticipant || avatarIdentities.length === 0) {
      console.warn('[gesture] No avatar participant available for action:', gesture);
      return;
    }

    await Promise.all(
      avatarIdentities.map((identity) =>
        localParticipant.performRpc({
          destinationIdentity: identity,
          method: 'trigger_dynamics',
          payload: JSON.stringify({
            action: gesture,
            identity: localParticipant.identity,
            timestamp: new Date().toISOString(),
          }),
        })
      )
    );
  }, [localParticipant, room.remoteParticipants]);
  const refreshMicrophoneDevices = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const nextMicrophones = devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Microphone ${index + 1}`,
      }));

    setMicrophoneDevices(nextMicrophones);

    if (nextMicrophones.length === 0) {
      setSelectedMicrophoneDeviceId('');
      return;
    }

    const activeDeviceGetter = room.getActiveDevice?.bind(room);
    const activeDeviceId =
      typeof activeDeviceGetter === 'function'
        ? activeDeviceGetter('audioinput')
        : '';

    setSelectedMicrophoneDeviceId((prev) => {
      if (prev && nextMicrophones.some((device) => device.deviceId === prev)) {
        return prev;
      }
      if (activeDeviceId && nextMicrophones.some((device) => device.deviceId === activeDeviceId)) {
        return activeDeviceId;
      }
      return nextMicrophones[0]?.deviceId ?? '';
    });
  }, [room]);
  const selectMicrophone = useCallback(async (deviceId: string) => {
    if (!deviceId) {
      return;
    }

    const switched = await room.switchActiveDevice('audioinput', deviceId);
    if (switched !== false) {
      setSelectedMicrophoneDeviceId(deviceId);
    }
  }, [room]);
  // Loading state and progress
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  
  // Get voice assistant state and audio track for visualizer
  const { state: agentState, audioTrack: agentAudioTrack } = voiceAssistant;
  
  // Get video tracks using the useTracks hook
  const localTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
    ],
    { onlySubscribed: false }
  );
  
  const localVideoTrack = localTracks.find(
    track => track.source === Track.Source.Camera
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    if (!room) {
      return;
    }

    const handleTurnHistory = (
      payload: Uint8Array,
      _participant?: unknown,
      _kind?: unknown,
      topic?: string,
    ) => {
      if (topic && topic !== 'turn_history') {
        return;
      }

      const text = new TextDecoder().decode(payload);

      try {
        const parsed = JSON.parse(text) as {
          type?: string;
          order?: number;
          role?: 'assistant' | 'user';
          content?: string;
        };

        const role = parsed.role;
        const content = parsed.content;

        if (parsed.type !== 'turn_history' || !role || !content) {
          return;
        }

        setMessages((current) => {
          if (current.some((message) => message.id === `${role}-${parsed.order}`)) {
            return current;
          }

          return [
            ...current,
            {
              id: `${role}-${parsed.order}`,
              role,
              content,
              timestamp: parsed.order ?? current.length + 1,
            },
          ].sort((a, b) => a.timestamp - b.timestamp);
        });
      } catch (error) {
        console.error('[playground] Failed to parse turn history packet', error, text);
      }
    };

    room.on(RoomEvent.DataReceived, handleTurnHistory);
    return () => {
      room.off(RoomEvent.DataReceived, handleTurnHistory);
    };
  }, [room]);

  useEffect(() => {
    if (roomState === ConnectionState.Disconnected) {
      setMessages([]);
    }
  }, [roomState]);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.log('messages for UI render', messages);
    }
  }, [messages]);
  //console.log('messages for UI render', messages);
  // Handle loading progress
  useEffect(() => {
    if (roomState === ConnectionState.Connected) {
      // Complete the progress and hide loading after a short delay
      setLoadingProgress(100);
      const timer = setTimeout(() => {
        setIsLoading(false);
      }, 800);
      return () => clearTimeout(timer);
    } else if (roomState === ConnectionState.Connecting) {
      // Simulate progress during connection
      const interval = setInterval(() => {
        setLoadingProgress(prev => {
          if (prev >= 90) return prev; // Stop at 90% until actually connected
          return prev + 2;
        });
      }, 200);
      return () => clearInterval(interval);
    }
  }, [roomState]);

  // Initialize loading progress
  useEffect(() => {
    const timer = setTimeout(() => {
      setLoadingProgress(10);
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    refreshMicrophoneDevices();

    if (!navigator.mediaDevices?.addEventListener) {
      return;
    }

    const handleDeviceChange = () => {
      void refreshMicrophoneDevices();
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [refreshMicrophoneDevices]);

  if (isLoading) {
    return <LoadingScreen progress={loadingProgress} />;
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      <div className="relative h-full max-h-[100dvh] w-full max-w-[calc(100dvh*9/16)] overflow-hidden ">
        <div className="relative z-10 h-full pt-10">
          <div className="h-[20%]">
          <h1>Tag line here</h1>
          </div>

          <div className="h-[80%] min-h-0 relative">
            <section className="absolute min-h-0 w-[90%] h-full right-0 left-[-20%] bottom-[0]">
              <div className="relative h-full w-full overflow-hidden bg-white">
                <VideoSection
                  roomState={roomState}
                  agentVideoTrack={voiceAssistant?.videoTrack}
                  localVideoTrack={localVideoTrack}
                  isCameraEnabled={isCameraEnabled}
                  showEmojiAnimation={false}
                  activeEmoji={null}
                  config={{ ...config, video_fit: 'cover' }}
                  isSlideCentric={false}
                />
              </div>
            </section>

            <section className="min-h-0 flex items-center overflow-hidden absolute top-[10%] bottom-[12%] right-[3%] w-1/2">
              <div className="flex w-full h-3/5 flex-col justify-end bg-[#007dff42] gap-4 px-3 py-16 rounded-[20px] overflow-y-auto ">
                {messages.map((message) => (
                  <article
                    key={message.id}
                    className={`max-w-[90%] rounded-[1.5rem] border px-4 py-3 shadow-lg ${
                      message.role === 'assistant'
                        ? 'mr-6 border-cyan-300/15 bg-cyan-300/10 text-white backdrop-blur-lg'
                        : 'ml-6 self-end border-white/10 bg-black/20 text-white/90 backdrop-blur-lg'
                    }`}
                  >
                    <p className="text-sm leading-6 text-white/88">{message.content}</p>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </div>
        
        {!isControlPopupOpen && (
          <button
            onClick={() => setIsControlPopupOpen(true)}
            className="absolute bottom-5 right-5 z-20 flex items-center gap-3 rounded-2xl border border-white/20 bg-white/10 px-4 py-3 text-white/85 shadow-lg backdrop-blur-md transition-all duration-300 hover:scale-105 hover:bg-white/15"
            title="Open controls"
          >
            <ControlsLauncherIcon />
            <span className="text-sm font-medium">Controls</span>
          </button>
        )}

        <ControlsWindow
          isOpen={isControlPopupOpen}
          onClose={closeControls}
          isCameraEnabled={isCameraEnabled}
          isMicEnabled={isMicEnabled}
          isAudioMuted={isAudioMuted}
          onToggleCamera={toggleCamera}
          onToggleMicrophone={toggleMicrophone}
          onToggleAudio={toggleAudio}
          onDisconnect={onDisconnect}
          onTriggerGesture={triggerGesture}
          microphoneDevices={microphoneDevices}
          selectedMicrophoneDeviceId={selectedMicrophoneDeviceId}
          onSelectMicrophone={selectMicrophone}
          agentState={agentState}
          agentAudioTrack={agentAudioTrack}
        />
      </div>
    </div>
  );
};

/**
 * Main Playground component that wraps the presenter in a context provider
 */
export default function Playground({
  autoConnect = false,
  onConnect,
}: PlaygroundProps) {
  const roomState = useConnectionState();
  const { localParticipant } = useLocalParticipant();
  const voiceAssistant = useVoiceAssistant();

  // Auto connect on mount if autoConnect is true
  useEffect(() => {
    if (autoConnect && roomState === ConnectionState.Disconnected) {
      onConnect(true);
    }
  }, [autoConnect, roomState, onConnect]);
    
  return (
    <PlaygroundProvider
      localParticipant={localParticipant}
      voiceAssistant={voiceAssistant}
      roomState={roomState}
    >
      <PlaygroundPresenter onDisconnect={() => onConnect(false)} />
    </PlaygroundProvider>
  );
}
