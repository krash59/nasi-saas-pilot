import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectForCustomer } from "@/lib/design/repository";
import { appendIntakeEventsTx, intakeModeTx, withIntake } from "@/lib/intake/repository";
import { DONE_TEXT, isBareNegative, questionById } from "@/lib/intake/protocol";
import { renderDirExtras, renderSummaryFields } from "@/lib/intake/project";

/**
 * Deterministic design intake (design v3). Every action is validated in code and stored as an append-only customer event;
 * no AI is involved. Signed-out callers get 401 (R18, owner D5).
 */
type Ctx = { params: Promise<{ projectId: string }> };
const text = z.string().trim().min(1).max(8000);
const qid = z.string().refine((v) => !!questionById(v), "UNKNOWN_QUESTION");
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("next"), question_id: qid }).strict(),
  z.object({ action: z.literal("none"), question_id: qid }).strict(),
  z.object({ action: z.literal("move"), message_id: z.string().uuid(), to_question_id: qid }).strict(),
  z.object({ action: z.literal("change"), question_id: qid, text }).strict(),
  z.object({ action: z.literal("confirm"), question_id: qid }).strict(),
  z.object({ action: z.literal("mark_open"), item_id: z.string().min(1).max(200), note: z.string().trim().max(2000).optional() }).strict(),
  z.object({ action: z.literal("settle"), item_id: z.string().min(1).max(200), decision: text }).strict(),
]);

class Refusal extends Error { constructor(public code: string, public status = 409) { super(code); } }

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    if (!(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    return NextResponse.json(await withIntake(projectId, async (tx, _c, view) => ({
      mode: await intakeModeTx(tx, projectId), view, summary_preview: renderSummaryFields(view), dir_extras_preview: renderDirExtras(view),
    })));
  } catch (e) {
    if (e instanceof Error && e.message === "UNAUTHENTICATED") return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    return NextResponse.json({ error: "INTAKE_READ_FAILED" }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    if (!(await getProjectForCustomer(projectId))) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    const body = actionSchema.parse(await req.json());
    const view = await withIntake(projectId, async (tx, customerId, view, events) => {
      if ((await intakeModeTx(tx, projectId)) !== "v3") throw new Refusal("INTAKE_NOT_ENABLED_FOR_THIS_PROJECT");
      const s = await tx`SELECT status FROM design_summaries WHERE project_id = ${projectId}::uuid`;
      if ((s[0] as { status?: string } | undefined)?.status === "approved") throw new Refusal("DESIGN_DISCUSSION_CLOSED");
      const q = "question_id" in body ? view.questions.find((x) => x.id === body.question_id)! : null;
      switch (body.action) {
        case "next": {
          if (view.active_question_id !== body.question_id) throw new Refusal("NOT_THE_ACTIVE_QUESTION");
          if (q!.state !== "answered") throw new Refusal("ANSWER_OR_NONE_REQUIRED");
          const after = await appendIntakeEventsTx(tx, projectId, customerId, [{ event_type: "NextPressed", question_id: body.question_id }]);
          const nq = after.active_question_id ? questionById(after.active_question_id)! : null;
          await tx`INSERT INTO design_messages (project_id, role, content, is_ai_draft)
            VALUES (${projectId}::uuid, 'assistant', ${nq ? nq.text : DONE_TEXT}, false)`;
          return after;
        }
        case "none": {
          if (q!.state === "answered") throw new Refusal("ANSWER_EXISTS");
          const wasActive = view.active_question_id === body.question_id;
          const after = await appendIntakeEventsTx(tx, projectId, customerId, [{ event_type: "FieldMarkedNone", question_id: body.question_id }]);
          if (wasActive) {
            const nq = after.active_question_id ? questionById(after.active_question_id)! : null;
            await tx`INSERT INTO design_messages (project_id, role, content, is_ai_draft)
              VALUES (${projectId}::uuid, 'assistant', ${nq ? nq.text : DONE_TEXT}, false)`;
          }
          return after;
        }
        case "move": {
          if (!events.some((e) => e.event_type === "AnswerGiven" && e.message_id === body.message_id)) throw new Refusal("MESSAGE_NOT_BOUND", 404);
          return appendIntakeEventsTx(tx, projectId, customerId, [{ event_type: "MessageMoved", message_id: body.message_id, question_id: body.to_question_id }]);
        }
        case "change": {
          if (isBareNegative(body.text)) throw new Refusal("USE_NONE_BUTTON", 400);
          return appendIntakeEventsTx(tx, projectId, customerId, [{ event_type: "AnswerReplaced", question_id: body.question_id, verbatim_text: body.text }]);
        }
        case "confirm": {
          if (q!.state === "empty") throw new Refusal("FIELD_EMPTY");
          return appendIntakeEventsTx(tx, projectId, customerId, [{ event_type: "SectionConfirmed", question_id: body.question_id }]);
        }
        case "mark_open": {
          if (!view.open_items.some((i) => i.item_id === body.item_id)) throw new Refusal("ITEM_NOT_FOUND", 404);
          return appendIntakeEventsTx(tx, projectId, customerId, [{ event_type: "OpenQuestionStatusSet", item_id: body.item_id, status: "OPEN", verbatim_text: body.note || null }]);
        }
        case "settle": {
          if (!view.open_items.some((i) => i.item_id === body.item_id)) throw new Refusal("ITEM_NOT_FOUND", 404);
          if (isBareNegative(body.decision)) throw new Refusal("DECISION_TEXT_REQUIRED", 400);
          return appendIntakeEventsTx(tx, projectId, customerId, [
            { event_type: "OpenQuestionStatusSet", item_id: body.item_id, status: "SETTLED" },
            { event_type: "DecisionRecorded", item_id: body.item_id, verbatim_text: body.decision },
          ]);
        }
      }
    });
    return NextResponse.json({ view, summary_preview: renderSummaryFields(view), dir_extras_preview: renderDirExtras(view) });
  } catch (e) {
    if (e instanceof Refusal) return NextResponse.json({ error: e.code }, { status: e.status });
    if (e instanceof z.ZodError || e instanceof SyntaxError) return NextResponse.json({ error: "INVALID_INTAKE_REQUEST" }, { status: 400 });
    if (e instanceof Error && e.message === "UNAUTHENTICATED") return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    return NextResponse.json({ error: "INTAKE_UPDATE_FAILED" }, { status: 500 });
  }
}
