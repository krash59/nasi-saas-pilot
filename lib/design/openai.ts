import { FOCUS_QUESTION, type ChatCapture } from "@/lib/design/capture";

/**
 * Design assistant. Owner rule (2026-11-19): the AI only ASSISTS. Its reply is shown in the chat as an AI draft and is
 * never stored as a requirement; the Design Summary is built deterministically from the customer's own words
 * (lib/design/capture.ts). The next question is fixed text chosen by the capture rule and appended by the app, so the
 * question always matches the area where the customer's answer will be stored.
 */
const SYSTEM_PROMPT = `You are an experienced software design consultant helping a non-technical customer shape their app idea.
Plain language, no jargon, warm and brief (at most 4 sentences).
Acknowledge what the customer just said. If they asked a question, answer it helpfully.
Do NOT ask any question yourself: the app adds the next question after your reply.
Never claim the customer approved anything. Do not authorize implementation or deployment.`;

export type DesignHistoryMessage = { role: "customer" | "assistant"; content: string };
export type AssistantReply = { content: string; isAiDraft: true; tokensUsed: number };

function localStubEnabled(): boolean {
  if (process.env.NASI_DESIGN_ASSISTANT_MODE !== "stub") return false;
  if (process.env.NODE_ENV !== "development") {
    throw new Error("LOCAL_STUB_MODE_REQUIRES_DEVELOPMENT");
  }
  return true;
}

export function getDesignAssistantMode(): "openai" | "local_stub" {
  return localStubEnabled() ? "local_stub" : "openai";
}

/** Deterministic: the fixed question for the area the next customer message will be stored in. */
export function nextQuestion(focus: ChatCapture["next_focus"]): string {
  return FOCUS_QUESTION[focus];
}

export async function generateDesignAssistantReply(
  history: DesignHistoryMessage[],
  focus: ChatCapture["next_focus"],
): Promise<AssistantReply> {
  if (localStubEnabled()) return generateDesignAssistantReplyStub(history, focus);
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY not configured");
  }
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role === "customer" ? ("user" as const) : ("assistant" as const), content: m.content })),
  ];
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL ?? "gpt-4o-mini", messages, temperature: 0.4 }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${text}`);
  }
  const data = await res.json();
  const said = data.choices?.[0]?.message?.content?.trim();
  if (!said) throw new Error("Empty model response");
  const content = `${said}\n\n${nextQuestion(focus)}`;
  // Meter what the provider reports; fall back to a size estimate if usage is absent.
  const reported = Number(data.usage?.total_tokens);
  const tokensUsed = Number.isFinite(reported) && reported > 0 ? Math.ceil(reported) : estimateTokens(messages, said);
  return { content, isAiDraft: true, tokensUsed };
}

/** Rough token estimate (about 4 characters per token) used when no provider count exists. */
export function estimateTokens(history: { content: string }[], reply: string): number {
  const chars = history.reduce((n, m) => n + m.content.length, 0) + reply.length;
  return Math.max(1, Math.ceil(chars / 4));
}

/** Deterministic stub for tests and offline verification (no OpenAI call). */
export function generateDesignAssistantReplyStub(history: DesignHistoryMessage[], focus: ChatCapture["next_focus"]): AssistantReply {
  const lastCustomer = [...history].reverse().find((m) => m.role === "customer");
  const content = `Thanks — I hear you on "${lastCustomer?.content?.slice(0, 80) ?? "your idea"}".\n\n${nextQuestion(focus)}`;
  return { content, isAiDraft: true, tokensUsed: estimateTokens(history, content) };
}
