import { NextResponse } from "next/server";
import {
  assertDesignChatOpen,
  ensureDesignConversationStarted,
  getProjectForCustomer,
  getProjectStageInfo,
  getSummaryFields,
  listDesignMessages,
  reviseDesignMessage,
} from "@/lib/design/repository";
import { appendIntakeEventsTx, intakeModeTx, withIntake } from "@/lib/intake/repository";
import { ACK_TEXT, isBareNegative } from "@/lib/intake/protocol";
import { z } from "zod";

/**
 * Design chat, fully deterministic (owner rule 2026-11-19): no AI call. A customer message is stored word for word and,
 * for intake-v3 projects, bound to the question that is active when it arrives; the reply is fixed text.
 */
const ASSISTANT_MODE = "deterministic";

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    const project = await getProjectForCustomer(projectId);
    if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const messages = await ensureDesignConversationStarted(projectId);
    const fields = await getSummaryFields(projectId);
    const stage = await getProjectStageInfo(projectId);
    const intake = await withIntake(projectId, async (tx, _c, view) => ({ mode: await intakeModeTx(tx, projectId), view }));
    return NextResponse.json({ messages, fields, intake, assistantMode: ASSISTANT_MODE, projectName: project.name,
      designVersion: project.design_version, chatOpen: stage?.summary_status !== "approved" });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }
    return NextResponse.json({ error: "DESIGN_MESSAGES_READ_FAILED" }, { status: 500 });
  }
}

// question_id: the question the customer saw when typing (expected version). A mismatch is refused, never re-bound.
const postSchema = z.object({ message: z.string().min(1).max(8000), question_id: z.string().max(64).optional() }).strict();

class Refusal extends Error { constructor(public code: string, public status = 409) { super(code); } }

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    const project = await getProjectForCustomer(projectId);
    if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    await assertDesignChatOpen(projectId);
    const { message, question_id: expectedQuestion } = postSchema.parse(await req.json());
    const intake = await withIntake(projectId, async (tx, customerId, view) => {
      const mode = await intakeModeTx(tx, projectId);
      if (mode === "v3") {
        if (isBareNegative(message)) throw new Refusal("USE_NONE_BUTTON", 400);
        if (!view.active_question_id) throw new Refusal("INTAKE_COMPLETE_USE_SUMMARY_PAGE");
        if (expectedQuestion && expectedQuestion !== view.active_question_id) throw new Refusal("QUESTION_CHANGED_RELOAD");
      }
      const ins = await tx`INSERT INTO design_messages (project_id, role, content, is_ai_draft)
        VALUES (${projectId}::uuid, 'customer', ${message}, false) RETURNING id`;
      const after = mode === "v3"
        ? await appendIntakeEventsTx(tx, projectId, customerId, [{ event_type: "AnswerGiven", question_id: view.active_question_id,
            message_id: String((ins[0] as { id: string }).id), verbatim_text: message }])
        : view;
      await tx`INSERT INTO design_messages (project_id, role, content, is_ai_draft)
        VALUES (${projectId}::uuid, 'assistant', ${ACK_TEXT}, false)`;
      return { mode, view: after };
    });
    const messages = await listDesignMessages(projectId);
    const fields = await getSummaryFields(projectId);
    return NextResponse.json({ messages, fields, intake, assistantMode: ASSISTANT_MODE });
  } catch (e) {
    if (e instanceof Refusal) return NextResponse.json({ error: e.code }, { status: e.status });
    const msg = e instanceof Error ? e.message : "Error";
    if (msg === "DESIGN_DISCUSSION_CLOSED") {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: msg }, { status: 401 });
    if (e instanceof z.ZodError || e instanceof SyntaxError) {
      return NextResponse.json({ error: "INVALID_DESIGN_MESSAGE" }, { status: 400 });
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
    if (body.action === "edit" && isBareNegative(body.content)) return NextResponse.json({ error: "USE_NONE_BUTTON" }, { status: 400 });
    // The edit/withdraw and its intake event commit in one transaction (R12): a confirmed answer then needs re-check.
    const messages = await reviseDesignMessage(projectId, body.messageId,
      body.action === "edit" ? { action: "edit", content: body.content } : { action: "withdraw" },
      async (tx, customerId) => {
        if ((await intakeModeTx(tx, projectId)) !== "v3") return;
        const bound = await tx`SELECT 1 FROM intake_events WHERE project_id = ${projectId}::uuid
          AND event_type = 'AnswerGiven' AND message_id = ${body.messageId}::uuid`;
        if (!bound.length) return;
        await appendIntakeEventsTx(tx, projectId, customerId, [body.action === "edit"
          ? { event_type: "AnswerAmended", message_id: body.messageId, verbatim_text: body.content }
          : { event_type: "AnswerWithdrawn", message_id: body.messageId }]);
      });
    return NextResponse.json({ messages, assistantMode: ASSISTANT_MODE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: msg }, { status: 401 });
    if (e instanceof z.ZodError || e instanceof SyntaxError) return NextResponse.json({ error: "INVALID_MESSAGE_CHANGE" }, { status: 400 });
    if (msg === "DESIGN_DISCUSSION_CLOSED") return NextResponse.json({ error: msg }, { status: 409 });
    if (["MESSAGE_NOT_FOUND", "ONLY_OWN_MESSAGES", "MESSAGE_WITHDRAWN"].includes(msg)) return NextResponse.json({ error: msg }, { status: 400 });
    return NextResponse.json({ error: "DESIGN_MESSAGE_CHANGE_FAILED" }, { status: 500 });
  }
}
