import { DESIGN_FIELDS_INSTRUCTION } from "@/lib/design/summary-extract";
import { buildScaffoldPromptAugment, getNextScaffoldFocus } from "@/lib/design/scaffolding";
import type { SummaryFields } from "@/lib/design/summary-fields";
import type { FieldProposals } from "@/lib/design/summary-extract";
import { extractFieldProposals } from "@/lib/design/summary-extract";

const SYSTEM_PROMPT = `You are an experienced software design consultant helping a non-technical customer shape their app idea.
Use TurboTax-style guidance: one focused question at a time, plain language, no jargon.
Propose structured content for these areas when helpful: problem, users, must-have features, out of scope, constraints, open questions.
Label your role as assistant only. Never claim the customer approved anything.
Do not authorize implementation or deployment.
${DESIGN_FIELDS_INSTRUCTION}`;

export type DesignHistoryMessage = { role: "customer" | "assistant"; content: string };

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

export async function generateDesignAssistantReply(
  history: DesignHistoryMessage[],
  options?: { fieldsSnapshot?: SummaryFields },
): Promise<{ content: string; isAiDraft: true; proposals: FieldProposals }> {
  if (localStubEnabled()) return generateDesignAssistantReplyStub(history, options);

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const focus = getNextScaffoldFocus(options?.fieldsSnapshot);
  const augment = buildScaffoldPromptAugment(focus, options?.fieldsSnapshot);

  const messages = [
    { role: "system" as const, content: `${SYSTEM_PROMPT}\n\n${augment}` },
    ...history.map((m) => ({
      role: m.role === "customer" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    })),
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      messages,
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${text}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("Empty model response");

  const { visibleContent, proposals } = extractFieldProposals(raw);
  return { content: visibleContent, isAiDraft: true, proposals };
}

/** Deterministic stub for tests and offline verification (no OpenAI call). */
export function generateDesignAssistantReplyStub(
  history: DesignHistoryMessage[],
  options?: { fieldsSnapshot?: SummaryFields },
): { content: string; isAiDraft: true; proposals: FieldProposals } {
  const focus = getNextScaffoldFocus(options?.fieldsSnapshot);
  const lastCustomer = [...history].reverse().find((m) => m.role === "customer");
  const content = `Thanks — I hear you on "${lastCustomer?.content?.slice(0, 80) ?? "your idea"}". Let's clarify ${focus} next. What would success look like for your users?`;
  return {
    content,
    isAiDraft: true,
    proposals: lastCustomer?.content
      ? { problem_statement: lastCustomer.content.slice(0, 200) }
      : {},
  };
}
