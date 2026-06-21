import type { ToolStatus } from "../sandbox/types.js";

export interface ChatInput {
  sessionId: string;
  message: string;
  requestId: string;
}

export interface ToolCallMeta {
  toolCallId: string;
  tool: string;
  pod: string | null;
  status: ToolStatus;
}

export interface ChatResult {
  sessionId: string;
  message: string;
  toolCalls: ToolCallMeta[];
}

/**
 * The seam that isolates the rest of the service from the Pi SDK (ADR-0005).
 * The shipped server is always backed by RealPiClient; tests may substitute a
 * fake to exercise the HTTP/lease layers in isolation.
 */
export interface PiClient {
  runChat(input: ChatInput): Promise<ChatResult>;
}
