import { NextResponse } from "next/server";
import {
  appendDesignMessage,
  assertDesignChatOpen,
  ensureDesignConversationStarted,
  getProjectForCustomer,
  getProjectStageInfo,
  getSummaryFields,
  listDesignMessages,
  reviseDesignMessage,
} from "@/lib/design/repository";
import { generateDesignAssistantReply, getDesignAssistantMode } from "@/lib/design/openai";
import { historyForAssistant } from "@/lib/design/history";
import { captureFromMessages, type CaptureRow } from "@/lib/design/capture";
import { assertDesignTokensAvailable, recordProjectUsage } from "@/lib/usage/repository";
import { UsageCapExceededError } from "@/lib/usage/meters";
import { z } from "zod";

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    const project = await getProjectForCustomer(projectId);
    if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const messages = await ensureDesignConversationStarted(projectId);
    const fields = await getSummaryFields(projectId);
    const stage = await getProjectStageInfo(projectId);
    return NextResponse.json({ messages, fields, capture: captureFromMessages(messages as CaptureRow[]), assistantMode: getDesignAssistantMode(), projectName: project.name,
      designVersion: project.design_version, chatOpen: stage?.summary_status !== "approved" });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }
    return NextResponse.json({ error: "DESIGN_MESSAGES_READ_FAILED" }, { status: 500 });
  }
}

const postSchema = z.object({ message: z.string().min(1).max(8000) }).strict();

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    const project = await getProjectForCustomer(projectId);
    if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    await assertDesignChatOpen(projectId);
    const { message } = postSchema.parse(await req.json());
    // BDD_F10_02: at or over the monthly token cap, refuse before storing or calling the model.
    await assertDesignTokensAvailable();
    await appendDesignMessage(projectId, "customer", message, false);

    const prior = await listDesignMessages(projectId);
    // DC-01: the AI receives only the current version of each message, never withdrawn or superseded text.
    const history = historyForAssistant(prior as { role: string; content: string; withdrawn_at?: unknown }[]);
    // Deterministic capture decides the next area; the AI reply is shown only, never stored as a requirement.
    const focus = captureFromMessages(prior as CaptureRow[]).next_focus;
    const reply = await generateDesignAssistantReply(history, focus);
    await recordProjectUsage(projectId, "design_tokens", reply.tokensUsed, `design_chat:${getDesignAssistantMode()}`);
    await appendDesignMessage(projectId, "assistant", reply.content, reply.isAiDraft);

    const messages = await listDesignMessages(projectId);
    const fields = await getSummaryFields(projectId);
    return NextResponse.json({ messages, fields, capture: captureFromMessages(messages as CaptureRow[]), assistantMode: getDesignAssistantMode() });
  } catch (e) {
    if (e instanceof UsageCapExceededError) {
      return NextResponse.json(
        { error: "USAGE_CAP_EXCEEDED", meter: e.meter, used: e.used, limit: e.limit },
        { status: 429 },
      );
    }
    const msg = e instanceof Error ? e.message : "Error";
    if (msg === "DESIGN_DISCUSSION_CLOSED") {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: msg }, { status: 401 });
    if (e instanceof z.ZodError || e instanceof SyntaxError) {
      return NextResponse.json({ error: "INVALID_DESIGN_MESSAGE" }, { status: 400 });
    }
    if (msg.includes("OPENAI")) {
      return NextResponse.json({ error: "DESIGN_ASSISTANT_UNAVAILABLE" }, { status: 503 });
    }
    return NextResponse.json({ error: "DESIGN_MESSAGE_FAILED" }, { status: 500 });
  }
}

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), messageId: z.string().uuid(), content: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ action: z.literal("withdraw"), messageId: z.string().uuid() }).strict(),
]);

/** DC-01: the customer edits or withdraws their own message before Design Summary approval (history is kept). */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    z.string().uuid().parse(projectId);
    if (!(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const body = patchSchema.parse(await req.json());
    const messages = await reviseDesignMessage(projectId, body.messageId,
      body.action === "edit" ? { action: "edit", content: body.content } : { action: "withdraw" });
    return NextResponse.json({ messages, assistantMode: getDesignAssistantMode() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: msg }, { status: 401 });
    if (e instanceof z.ZodError || e instanceof SyntaxError) return NextResponse.json({ error: "INVALID_MESSAGE_CHANGE" }, { status: 400 });
    if (msg === "DESIGN_DISCUSSION_CLOSED") return NextResponse.json({ error: msg }, { status: 409 });
    if (["MESSAGE_NOT_FOUND", "ONLY_OWN_MESSAGES", "MESSAGE_WITHDRAWN"].includes(msg)) return NextResponse.json({ error: msg }, { status: 400 });
    return NextResponse.json({ error: "DESIGN_MESSAGE_CHANGE_FAILED" }, { status: 500 });
  }
}
