import { NextResponse } from "next/server";
import {
  appendDesignMessage,
  assertDesignChatOpen,
  ensureDesignConversationStarted,
  getProjectForCustomer,
  getSummaryFields,
  listDesignMessages,
  mergeAiProposedFields,
} from "@/lib/design/repository";
import { generateDesignAssistantReply, getDesignAssistantMode } from "@/lib/design/openai";
import { z } from "zod";

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    const project = await getProjectForCustomer(projectId);
    if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const messages = await ensureDesignConversationStarted(projectId);
    const fields = await getSummaryFields(projectId);
    return NextResponse.json({ messages, fields, assistantMode: getDesignAssistantMode() });
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
    await appendDesignMessage(projectId, "customer", message, false);

    const prior = await listDesignMessages(projectId);
    const history = (prior as { role: string; content: string }[]).map((m) => ({
      role: m.role as "customer" | "assistant",
      content: m.content,
    }));
    const fieldsSnapshot = await getSummaryFields(projectId);

    const reply = await generateDesignAssistantReply(history, { fieldsSnapshot });
    await appendDesignMessage(projectId, "assistant", reply.content, reply.isAiDraft);
    await mergeAiProposedFields(projectId, reply.proposals);

    const messages = await listDesignMessages(projectId);
    const fields = await getSummaryFields(projectId);
    return NextResponse.json({ messages, fields, assistantMode: getDesignAssistantMode() });
  } catch (e) {
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
