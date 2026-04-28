/* eslint-disable @next/next/no-img-element */
import React, { useRef} from 'react';
import { VideoTrack, TrackReferenceOrPlaceholder } from '@livekit/components-react';
import { ConnectionState } from 'livekit-client';

interface VideoDisplayProps {
  agentVideoTrack?: TrackReferenceOrPlaceholder;
  localVideoTrack?: TrackReferenceOrPlaceholder;
  isCameraEnabled: boolean;
  roomState: ConnectionState;
  videoFit: string;
  avatarImage?: string;
}

export const VideoDisplay = ({
  agentVideoTrack,
  localVideoTrack,
  isCameraEnabled,
  videoFit = 'cover',
  avatarImage,
}: VideoDisplayProps) => {
  const agentVideoRef = useRef<HTMLDivElement | null>(null);
  const fitClass = videoFit === 'cover' ? '!object-cover' : '!object-contain';

  return (
    <div className="relative w-full h-full bg-transparent overflow-hidden">
      {/* Avatar placeholder image (shown while waiting for video stream) */}
      {!agentVideoTrack && avatarImage && (
        <div className="absolute inset-0 flex items-center justify-center">
          <img src={avatarImage} alt="" className="w-full h-full object-cover" />
        </div>
      )}

      {/* Agent video */}
      {agentVideoTrack && (
        <div className="absolute inset-0" ref={agentVideoRef}>
          <VideoTrack
            trackRef={agentVideoTrack}
            className={`w-full h-full ${fitClass} brightness-[1.025]`}
          />
        </div>
      )}

      {/* Local user video */}
      {localVideoTrack && isCameraEnabled && (
        <div className="absolute top-4 right-4 w-48 h-36 bg-gray-800 rounded-lg overflow-hidden border-2 border-white/20">
          <VideoTrack
            trackRef={localVideoTrack}
            className="w-full h-full !object-cover brightness-[1.025]"
          />
        </div>
      )}
    </div>
  );
};
