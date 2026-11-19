import { buildScaffoldPromptAugment, getNextScaffoldFocus } from "@/lib/design/scaffolding";
import { SUMMARY_FIELD_KEYS, type SummaryFields } from "@/lib/design/summary-fields";
import type { FieldProposals } from "@/lib/design/summary-extract";
import { extractFieldProposals } from "@/lib/design/summary-extract";

const FIELD_GUIDE = `Summary areas (keys) and what counts for each:
- problem_statement: the problem or goal the customer wants the app to solve.
- users_personas: every person, role or group the customer says will use or benefit from the app (e.g. "staff", "patients", "managers"), even if mentioned in passing.
- must_have_features: features or capabilities the customer needs or asks for.
- out_of_scope: things the customer says to leave out, avoid, or postpone.
- constraints: budget, timeline, team, technology, legal or other limits the customer mentions.
- open_questions: questions or uncertainties the customer raised that are not yet settled.
For EVERY area, write a complete, up-to-date draft that summarises everything the customer has said about it anywhere in the
conversation so far (not only the latest message, and not only the current focus), in the customer's own terms. Use null only when
the customer has said nothing that fits that area. Never invent requirements the customer did not state.`;

const SYSTEM_PROMPT = `You are an experienced software design consultant helping a non-technical customer shape their app idea.
Use TurboTax-style guidance: one focused question at a time, plain language, no jargon.
Label your role as assistant only. Never claim the customer approved anything.
Do not authorize implementation or deployment.
Answer as JSON: "reply" is your customer-facing message; "fields" holds the Design Summary drafts.
When every area has a draft, tell the customer they can review and confirm them on the Design Summary page.
${FIELD_GUIDE}`;

const SUMMARY_PROMPT = `You read a design conversation between a customer and an assistant and draft the customer's Design Summary.
Answer as JSON with one key per summary area. Draft only from what the CUSTOMER said; never invent requirements.
${FIELD_GUIDE}`;

const NULLABLE_TEXT = { type: ["string", "null"] } as const;
const FIELDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...SUMMARY_FIELD_KEYS],
  properties: Object.fromEntries(SUMMARY_FIELD_KEYS.map((k) => [k, NULLABLE_TEXT])),
};
/** Structured output: the model must return every summary area on every turn (it can no longer skip the field drafts). */
const TURN_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "design_turn",
    strict: true,
    schema: { type: "object", additionalProperties: false, required: ["reply", "fields"], properties: { reply: { type: "string" }, fields: FIELDS_SCHEMA } },
  },
};
const SUMMARY_FORMAT = { type: "json_schema", json_schema: { name: "design_summary_fields", strict: true, schema: FIELDS_SCHEMA } };

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

/** Keeps only non-empty text for known summary areas. */
export function proposalsFromFields(fields: unknown): FieldProposals {
  const out: FieldProposals = {};
  if (!fields || typeof fields !== "object") return out;
  for (const key of SUMMARY_FIELD_KEYS) {
    const v = (fields as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  return out;
}

/** Reads a structured turn ({reply, fields}); falls back to the older hidden-block format if the JSON is not usable. */
export function parseDesignTurn(raw: string): { visibleContent: string; proposals: FieldProposals } {
  try {
    const parsed = JSON.parse(raw) as { reply?: unknown; fields?: unknown };
    if (typeof parsed.reply === "string" && parsed.reply.trim()) {
      return { visibleContent: parsed.reply.trim(), proposals: proposalsFromFields(parsed.fields) };
    }
  } catch {
    /* not JSON: fall through */
  }
  return extractFieldProposals(raw);
}

async function callOpenAi(messages: { role: "system" | "user" | "assistant"; content: string }[], responseFormat: object) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY not configured");
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(60000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      messages,
      temperature: 0.4,
      response_format: responseFormat,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${text}`);
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("Empty model response");
  // Meter what the provider reports; fall back to a size estimate if usage is absent.
  const reported = Number(data.usage?.total_tokens);
  const tokensUsed = Number.isFinite(reported) && reported > 0 ? Math.ceil(reported) : estimateTokens(messages, raw);
  return { raw: raw as string, tokensUsed };
}

const toChat = (history: DesignHistoryMessage[]) =>
  history.map((m) => ({ role: m.role === "customer" ? ("user" as const) : ("assistant" as const), content: m.content }));

export async function generateDesignAssistantReply(
  history: DesignHistoryMessage[],
  options?: { fieldsSnapshot?: SummaryFields },
): Promise<{ content: string; isAiDraft: true; proposals: FieldProposals; tokensUsed: number }> {
  if (localStubEnabled()) return generateDesignAssistantReplyStub(history, options);

  const focus = getNextScaffoldFocus(options?.fieldsSnapshot);
  const augment = buildScaffoldPromptAugment(focus, options?.fieldsSnapshot);
  const { raw, tokensUsed } = await callOpenAi(
    [{ role: "system", content: `${SYSTEM_PROMPT}\n\n${augment}` }, ...toChat(history)],
    TURN_FORMAT,
  );
  const { visibleContent, proposals } = parseDesignTurn(raw);
  return { content: visibleContent, isAiDraft: true, proposals, tokensUsed };
}

/** "Fill from chat": drafts every summary area from the whole conversation (AI drafts only; the customer still confirms). */
export async function draftSummaryFromConversation(
  history: DesignHistoryMessage[],
): Promise<{ proposals: FieldProposals; tokensUsed: number }> {
  if (localStubEnabled()) {
    const said = history.filter((m) => m.role === "customer").map((m) => m.content).join("\n");
    return { proposals: said ? { problem_statement: said.slice(0, 200) } : {}, tokensUsed: estimateTokens(history, "") };
  }
  if (!history.some((m) => m.role === "customer")) return { proposals: {}, tokensUsed: 0 };
  const transcript = history.map((m) => `${m.role === "customer" ? "CUSTOMER" : "ASSISTANT"}: ${m.content}`).join("\n\n");
  const { raw, tokensUsed } = await callOpenAi(
    [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: transcript }],
    SUMMARY_FORMAT,
  );
  let proposals: FieldProposals = {};
  try { proposals = proposalsFromFields(JSON.parse(raw)); } catch { proposals = {}; }
  return { proposals, tokensUsed };
}

/** Rough token estimate (about 4 characters per token) used when no provider count exists. */
export function estimateTokens(history: { content: string }[], reply: string): number {
  const chars = history.reduce((n, m) => n + m.content.length, 0) + reply.length;
  return Math.max(1, Math.ceil(chars / 4));
}

/** Deterministic stub for tests and offline verification (no OpenAI call). */
export function generateDesignAssistantReplyStub(
  history: DesignHistoryMessage[],
  options?: { fieldsSnapshot?: SummaryFields },
): { content: string; isAiDraft: true; proposals: FieldProposals; tokensUsed: number } {
  const focus = getNextScaffoldFocus(options?.fieldsSnapshot);
  const lastCustomer = [...history].reverse().find((m) => m.role === "customer");
  const content = `Thanks — I hear you on "${lastCustomer?.content?.slice(0, 80) ?? "your idea"}". Let's clarify ${focus} next. What would success look like for your users?`;
  return {
    content,
    isAiDraft: true,
    tokensUsed: estimateTokens(history, content),
    proposals: lastCustomer?.content
      ? { problem_statement: lastCustomer.content.slice(0, 200) }
      : {},
  };
}
