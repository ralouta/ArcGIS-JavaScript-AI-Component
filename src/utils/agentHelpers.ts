import { AIMessage } from "@langchain/core/messages";

/**
 * Flatten potentially nested message arrays into a flat array.
 */
export function normalizeMessages(messages: any): any[] {
  const rawMessages = Array.isArray(messages) ? messages : [];
  if (rawMessages.length === 1 && Array.isArray(rawMessages[0])) return rawMessages[0];
  return rawMessages.flatMap((m: any) => (Array.isArray(m) ? m : [m]));
}

/**
 * Walk backward through messages to find the last AIMessage.
 */
export function getLastAiMessage(messages: any[]): AIMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (AIMessage.isInstance(messages[i])) return messages[i];
  }
  return null;
}

/**
 * Extract a plain-text string from LangChain message content (string or content array).
 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as any).text === "string") {
          return (part as any).text;
        }
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * Extract the text of the last human/user message from a LanGraph state object.
 */
export function extractLastUserText(state: any): string {
  const rawMessages = Array.isArray(state?.messages) ? state.messages : [];
  const messages = rawMessages.length > 0 && Array.isArray(rawMessages[0]) ? rawMessages.flat() : rawMessages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (typeof msg.lc_kwargs?.content === "string") return msg.lc_kwargs.content.trim();
    if (typeof msg.kwargs?.content === "string") return msg.kwargs.content.trim();
    if (typeof msg.content === "string") return msg.content.trim();
  }
  return "";
}
