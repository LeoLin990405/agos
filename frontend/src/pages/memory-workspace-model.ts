export interface MemoryIntent {
  sessionId?: string;
  nodeId?: string;
}

/** One-shot jump into the memory workspace. Empty object still means "open the desk". */
export function memoryIntent(input?: MemoryIntent): MemoryIntent {
  if (input === undefined) return {};
  const sessionId = input.sessionId?.trim();
  const nodeId = input.nodeId?.trim();
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(nodeId ? { nodeId } : {}),
  };
}

export function consumeMemoryIntent(intent: MemoryIntent | undefined): MemoryIntent | undefined {
  if (intent === undefined) return undefined;
  return memoryIntent(intent);
}

/** Picked dock session wins; otherwise the live conversation. Never invents an id. */
export function resolveWorkingSessionId(
  pickedSessionId: string | undefined,
  liveActiveSessionId: string | undefined,
): string | undefined {
  const picked = pickedSessionId?.trim();
  if (picked) return picked;
  const live = liveActiveSessionId?.trim();
  return live === undefined || live === '' ? undefined : live;
}
