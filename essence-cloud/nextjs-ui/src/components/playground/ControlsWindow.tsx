"use client";

import React, { useEffect, useState } from 'react';
import { BarVisualizer, TrackReferenceOrPlaceholder } from '@livekit/components-react';
import { createPortal } from 'react-dom';

type BarVisualizerState = React.ComponentProps<typeof BarVisualizer>['state'];
interface MicrophoneOption {
  deviceId: string;
  label: string;
}

interface ControlsWindowProps {
  isOpen: boolean;
  onClose: () => void;
  isCameraEnabled: boolean;
  isMicEnabled: boolean;
  isAudioMuted: boolean;
  onToggleCamera: () => void | Promise<void>;
  onToggleMicrophone: () => void | Promise<void>;
  onToggleAudio: () => void;
  onDisconnect: () => void;
  onTriggerGesture: (gesture: GestureAction) => void | Promise<void>;
  microphoneDevices: MicrophoneOption[];
  selectedMicrophoneDeviceId: string;
  onSelectMicrophone: (deviceId: string) => void | Promise<void>;
  agentState: BarVisualizerState;
  agentAudioTrack?: TrackReferenceOrPlaceholder;
}

export type GestureAction =
  | 'mini_wave_hello'
  | 'clap_cheer'
  | 'heart_hands'
  | 'blow_kiss_heart';

const CameraIcon = ({ enabled }: { enabled: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {!enabled && <line x1="1" y1="1" x2="23" y2="23" />}
    <polygon points="23 7 16 12 23 17 23 7" />
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
  </svg>
);

const MicrophoneIcon = ({ enabled }: { enabled: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {!enabled && <line x1="1" y1="1" x2="23" y2="23" />}
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

const AudioIcon = ({ enabled }: { enabled: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {!enabled && <line x1="23" y1="9" x2="17" y2="15" />}
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    {enabled && (
      <>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      </>
    )}
  </svg>
);

const DisconnectIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 17l5-5-5-5" />
    <path d="M15 12H3" />
    <path d="M21 19V5a2 2 0 0 0-2-2h-6" />
  </svg>
);

export const ControlsLauncherIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="6" x2="20" y2="6" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="18" x2="20" y2="18" />
  </svg>
);

export default function ControlsWindow({
  isOpen,
  onClose,
  isCameraEnabled,
  isMicEnabled,
  isAudioMuted,
  onToggleCamera,
  onToggleMicrophone,
  onToggleAudio,
  onDisconnect,
  onTriggerGesture,
  microphoneDevices,
  selectedMicrophoneDeviceId,
  onSelectMicrophone,
  agentState,
  agentAudioTrack,
}: ControlsWindowProps) {
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [popupWindow, setPopupWindow] = useState<Window | null>(null);

  useEffect(() => {
    if (!isOpen) {
      popupWindow?.close();
      setPopupWindow(null);
      setContainerEl(null);
      return;
    }

    const nextPopup = window.open(
      '',
      'bithuman-controls',
      'popup=yes,width=380,height=520,resizable=yes,scrollbars=no'
    );

    if (!nextPopup) {
      onClose();
      return;
    }

    nextPopup.document.title = 'bitHuman Controls';
    nextPopup.document.body.innerHTML = '';
    nextPopup.document.body.style.margin = '0';
    nextPopup.document.body.style.background = '#020617';

    document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
      nextPopup.document.head.appendChild(node.cloneNode(true));
    });

    const mountNode = nextPopup.document.createElement('div');
    mountNode.id = 'controls-popup-root';
    nextPopup.document.body.appendChild(mountNode);

    const handleBeforeUnload = () => onClose();
    nextPopup.addEventListener('beforeunload', handleBeforeUnload);
    nextPopup.focus();

    setPopupWindow(nextPopup);
    setContainerEl(mountNode);

    return () => {
      nextPopup.removeEventListener('beforeunload', handleBeforeUnload);
      nextPopup.close();
    };
  }, [isOpen, onClose]);

  if (!isOpen || !containerEl) {
    return null;
  }

  return createPortal(
    <div className="min-h-screen bg-slate-950 p-4 text-white">
      <div className="rounded-[2rem] border border-white/20 bg-slate-950/80 p-5 shadow-[0_20px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <div className="mb-5 flex items-center justify-between">
          <p className="text-sm font-medium text-white/90">Controls</p>
          <button
            onClick={onClose}
            className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-sm text-white/75 transition-all duration-300 hover:bg-white/10 hover:text-white"
            title="Close controls"
          >
            Close
          </button>
        </div>

        {isMicEnabled && agentAudioTrack && (
          <div className="mb-4 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-green-400 animate-pulse"></div>
              <span className="text-sm font-medium text-white/90">Listening</span>
            </div>
            <div className="h-8 w-16">
              <BarVisualizer
                state={agentState}
                barCount={5}
                trackRef={agentAudioTrack}
                className="lk-audio-bar-visualizer-glass"
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={onToggleCamera}
            className={`
              flex items-center justify-center gap-2 rounded-2xl border border-white/20 bg-white/10 px-4 py-4 text-white/80 backdrop-blur-sm transition-all duration-300
              hover:scale-[1.02] hover:border-white/30 hover:bg-white/20 hover:text-white
              active:scale-95 active:bg-white/30
              ${!isCameraEnabled ? 'opacity-50' : 'opacity-100'}
            `}
            title={isCameraEnabled ? 'Turn camera off' : 'Turn camera on'}
          >
            <CameraIcon enabled={isCameraEnabled} />
            <span className="text-sm">{isCameraEnabled ? 'Camera On' : 'Camera Off'}</span>
          </button>

          <button
            onClick={onToggleMicrophone}
            className={`
              flex items-center justify-center gap-2 rounded-2xl border border-white/20 bg-white/10 px-4 py-4 text-white/80 backdrop-blur-sm transition-all duration-300
              hover:scale-[1.02] hover:border-white/30 hover:bg-white/20 hover:text-white
              active:scale-95 active:bg-white/30
              ${!isMicEnabled ? 'opacity-50' : 'opacity-100'}
            `}
            title={isMicEnabled ? 'Turn microphone off' : 'Turn microphone on'}
          >
            <MicrophoneIcon enabled={isMicEnabled} />
            <span className="text-sm">{isMicEnabled ? 'Mic On' : 'Mic Off'}</span>
          </button>

          <button
            onClick={onToggleAudio}
            className={`
              flex items-center justify-center gap-2 rounded-2xl border border-white/20 bg-white/10 px-4 py-4 text-white/80 backdrop-blur-sm transition-all duration-300
              hover:scale-[1.02] hover:border-white/30 hover:bg-white/20 hover:text-white
              active:scale-95 active:bg-white/30
              ${isAudioMuted ? 'opacity-50' : 'opacity-100'}
            `}
            title={!isAudioMuted ? 'Mute audio' : 'Unmute audio'}
          >
            <AudioIcon enabled={!isAudioMuted} />
            <span className="text-sm">{isAudioMuted ? 'Audio Off' : 'Audio On'}</span>
          </button>

          <button
            onClick={onDisconnect}
            className="
              flex items-center justify-center gap-2 rounded-2xl border border-red-300/25 bg-red-500/15 px-4 py-4 text-red-100 backdrop-blur-sm transition-all duration-300
              hover:scale-[1.02] hover:border-red-200/40 hover:bg-red-500/25
              active:scale-95 active:bg-red-500/35
            "
            title="Disconnect room"
          >
            <DisconnectIcon />
            <span className="text-sm">Disconnect</span>
          </button>
        </div>

        <div className="mt-5">
          <label className="mb-3 block text-sm font-medium text-white/90" htmlFor="microphone-select">
            Input Microphone
          </label>
          <select
            id="microphone-select"
            value={selectedMicrophoneDeviceId}
            onChange={(event) => void onSelectMicrophone(event.target.value)}
            className="w-full rounded-2xl border border-white/20 bg-white/10 px-4 py-3 text-sm text-white outline-none transition-all duration-300 hover:bg-white/15 focus:border-white/35"
          >
            {microphoneDevices.length === 0 ? (
              <option value="">No microphone found</option>
            ) : (
              microphoneDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId} className="bg-slate-950 text-black">
                  {device.label}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="mt-5">
          <p className="mb-3 text-sm font-medium text-white/90">Gestures</p>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => onTriggerGesture('mini_wave_hello')}
              className="rounded-2xl border border-white/20 bg-white/10 px-4 py-4 text-sm text-white/85 transition-all duration-300 hover:scale-[1.02] hover:bg-white/20 active:scale-95"
            >
              Hello
            </button>
            <button
              onClick={() => onTriggerGesture('clap_cheer')}
              className="rounded-2xl border border-white/20 bg-white/10 px-4 py-4 text-sm text-white/85 transition-all duration-300 hover:scale-[1.02] hover:bg-white/20 active:scale-95"
            >
              Clap
            </button>
            <button
              onClick={() => onTriggerGesture('heart_hands')}
              className="rounded-2xl border border-white/20 bg-white/10 px-4 py-4 text-sm text-white/85 transition-all duration-300 hover:scale-[1.02] hover:bg-white/20 active:scale-95"
            >
              Heart Hands
            </button>
            <button
              onClick={() => onTriggerGesture('blow_kiss_heart')}
              className="rounded-2xl border border-white/20 bg-white/10 px-4 py-4 text-sm text-white/85 transition-all duration-300 hover:scale-[1.02] hover:bg-white/20 active:scale-95"
            >
              Blow Kiss
            </button>
          </div>
        </div>
      </div>
    </div>,
    containerEl
  );
}
