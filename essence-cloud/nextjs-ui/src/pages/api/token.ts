import { NextApiRequest, NextApiResponse } from "next";
import { AccessToken, AgentDispatchClient, VideoGrant } from "livekit-server-sdk";

const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const apiUrl = process.env.LIVEKIT_API_URL;
const agentName = process.env.LIVEKIT_AGENT_NAME?.trim() || "";

console.log("[token-api] Config:", {
  apiKey: apiKey ? `${apiKey.substring(0, 4)}...` : "(not set)",
});

// Workers only need explicit dispatch when `agent_name` is set.
export default async function handleToken(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    if (!apiKey || !apiSecret) {
      res.statusMessage = "Environment variables aren't set up correctly";
      res.status(500).end();
      return;
    }

    const requestedRoomName = (req.query.roomName as string) || "";
    const roomName =
      requestedRoomName && requestedRoomName !== "default-room"
        ? requestedRoomName
        : `room-${Math.random().toString(36).slice(2, 10)}`;
    const identity =
      (req.query.participantName as string) ||
      `user-${Math.random().toString(36).substring(7)}`;

    console.log("[token-api] Token request:", { roomName, identity });

    const grant: VideoGrant = {
      room: roomName,
      roomJoin: true,
      roomCreate: true,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
    };

    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name: identity,
      ttl: 3600,
    });

    at.addGrant(grant);
    const token = await at.toJwt();

    if (apiUrl && agentName) {
      const dispatchClient = new AgentDispatchClient(apiUrl, apiKey, apiSecret);
      let existingDispatches: Awaited<ReturnType<typeof dispatchClient.listDispatch>> = [];

      try {
        existingDispatches = await dispatchClient.listDispatch(roomName);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status !== 404) {
          throw error;
        }
      }

      for (const dispatch of existingDispatches) {
        await dispatchClient.deleteDispatch(dispatch.id, roomName);
      }

      if (existingDispatches.length > 0) {
        console.log("[token-api] Cleared existing dispatches:", {
          roomName,
          identity,
          agentName,
          count: existingDispatches.length,
        });
      }

      const dispatch = await dispatchClient.createDispatch(roomName, agentName, {
        metadata: JSON.stringify({ participantName: identity }),
      });

      console.log("[token-api] Agent dispatch created:", {
        roomName,
        identity,
        agentName: dispatch.agentName,
        dispatchId: dispatch.id,
      });
    }

    const clientUrl =
      process.env.NEXT_PUBLIC_LIVEKIT_URL ||
      `ws://${req.headers.host || "localhost:4202"}`;

    console.log("[token-api] Token issued:", { roomName, identity, url: clientUrl });

    res.status(200).json({
      accessToken: token,
      url: clientUrl,
      avatarImage: process.env.BITHUMAN_AVATAR_IMAGE || "",
    });
  } catch (e) {
    console.error("[token-api] Error:", e);
    res.statusMessage = (e as Error).message;
    res.status(500).end();
  }
}
