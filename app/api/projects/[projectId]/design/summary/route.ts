import { NextResponse } from "next/server";
import {
  approveDesignSummary,
  confirmSummaryField,
  getOrCreateSummary,
  getProjectForCustomer,
  getProjectStageInfo,
  listDesignMessages,
  mergeAiProposedFields,
} from "@/lib/design/repository";
import { historyForAssistant } from "@/lib/design/history";
import { draftSummaryFromConversation, getDesignAssistantMode } from "@/lib/design/openai";
import { assertDesignTokensAvailable, recordProjectUsage } from "@/lib/usage/repository";
import { UsageCapExceededError } from "@/lib/usage/meters";
import { SUMMARY_FIELD_KEYS, type SummaryFieldKey } from "@/lib/design/summary-fields";
import { denyAgenticWithoutApprovedSummary } from "@/lib/design/stage-gate";
import { z } from "zod";
import { generateDirDraft } from "@/lib/design/dir-repository";
import { authorizeImplementation, revokeImplementation } from "@/lib/design/implementation-consent";
import { sendNwsJob } from "@/lib/nws/job";

type Ctx = { params: Promise<{ projectId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
 try {
  const { projectId } = await ctx.params;
  if (!(await getProjectForCustomer(projectId))) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const summary = await getOrCreateSummary(projectId);
  const stage = await getProjectStageInfo(projectId);
  return NextResponse.json({
    summary,
    stage,
    agenticBlocked: true,
    implementationConsentRequired: true,
  });
 } catch (error) {
   if (error instanceof Error && error.message === "UNAUTHENTICATED") {
     return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
   }
   return NextResponse.json({ error: "DESIGN_SUMMARY_READ_FAILED" }, { status: 500 });
 }
}

const confirmSchema = z.object({
  action: z.literal("confirm_field"),
  field: z.enum(SUMMARY_FIELD_KEYS as unknown as [SummaryFieldKey, ...SummaryFieldKey[]]),
  customer_confirmed: z.string().max(8000), // DC-01: an empty value clears the field before approval
  ai_proposed: z.string().optional(),
}).strict();

const approveSchema = z.object({ action: z.literal("approve") }).strict();
const fillSchema = z.object({ action: z.literal("fill_from_chat") }).strict();

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    if (!(await getProjectForCustomer(projectId))) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const body = await req.json();
    const action = z.object({ action: z.string() }).passthrough().parse(body).action;
    if (action === "approve") {
      approveSchema.parse(body);
      const result = await approveDesignSummary(projectId);
      try {
        const draft = await generateDirDraft(projectId);
        return NextResponse.json({ ...result, draft });
      } catch {
        // Approval is durable even if draft storage is temporarily unavailable.
        // The approved-summary UI exposes the idempotent recovery endpoint.
        return NextResponse.json({ ...result, dir_error: "DIR_GENERATION_FAILED_RETRY" });
      }
    }
    if (action === "fill_from_chat") {
      // AI drafts for every unconfirmed area from the whole conversation; confirmed text is never touched.
      fillSchema.parse(body);
      const summary = (await getOrCreateSummary(projectId)) as { status?: string };
      if (summary.status === "approved") throw new Error("SUMMARY_ALREADY_APPROVED");
      await assertDesignTokensAvailable();
      const rows = await listDesignMessages(projectId);
      const history = historyForAssistant(rows as { role: string; content: string; withdrawn_at?: unknown }[]);
      const { proposals, tokensUsed } = await draftSummaryFromConversation(history);
      if (tokensUsed > 0) await recordProjectUsage(projectId, "design_tokens", tokensUsed, `summary_fill:${getDesignAssistantMode()}`);
      const fields = await mergeAiProposedFields(projectId, proposals);
      return NextResponse.json({ fields, filled: Object.keys(proposals) });
    }
    const parsed = confirmSchema.parse(body);
    const fields = await confirmSummaryField(
      projectId,
      parsed.field,
      parsed.customer_confirmed.trim() || null,
      parsed.ai_proposed,
    );
    return NextResponse.json({ fields });
  } catch (e) {
    if (e instanceof UsageCapExceededError) {
      return NextResponse.json({ error: "USAGE_CAP_EXCEEDED", meter: e.meter, used: e.used, limit: e.limit }, { status: 429 });
    }
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: msg }, { status: 401 });
    if (e instanceof z.ZodError || e instanceof SyntaxError) {
      return NextResponse.json({ error: "INVALID_SUMMARY_REQUEST" }, { status: 400 });
    }
    if (msg.includes("OPENAI") || msg.startsWith("OpenAI error") || msg === "Empty model response") {
      return NextResponse.json({ error: "DESIGN_ASSISTANT_UNAVAILABLE" }, { status: 503 });
    }
    if (["FIELDS_NOT_CONFIRMED", "SUMMARY_NOT_FOUND", "SUMMARY_ALREADY_APPROVED"].includes(msg)) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    return NextResponse.json({ error: "DESIGN_SUMMARY_UPDATE_FAILED" }, { status: 500 });
  }
}

/** Customer consent only; this endpoint never grants NWS execution or release. */
const implementationSchema = z.object({
  confirmed: z.literal(true),
  reviewedContent: z.record(z.string(), z.unknown()),
}).strict();
export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    z.string().uuid().parse(projectId);
    if (!(await getProjectForCustomer(projectId))) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const body = implementationSchema.parse(await req.json());
    const stage = await getProjectStageInfo(projectId);
    if (!stage || denyAgenticWithoutApprovedSummary(stage)) {
      return NextResponse.json({ error: "DESIGN_SUMMARY_NOT_APPROVED" }, { status: 403 });
    }
    const consent = await authorizeImplementation(projectId, body.reviewedContent);
    // DC-06: after test-build authorization the full job goes to NWS. The consent stands even if sending fails
    // (the customer can re-send from the same page; POST /nws-handoff/job is idempotent).
    let nwsHandoff: { id: string; job_sha256: string; sent_at: unknown; received_at: unknown } | null = null;
    try {
      const sent = await sendNwsJob(projectId);
      nwsHandoff = (sent.handoff ?? null) as unknown as typeof nwsHandoff;
    } catch { nwsHandoff = null; }
    return NextResponse.json({ ...consent, nwsHandoff }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: "INVALID_IMPLEMENTATION_CONSENT" }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "";
    if (message === "UNAUTHENTICATED") return NextResponse.json({ error: message }, { status: 401 });
    if (message === "APPROVED_DIR_REVIEW_MISMATCH") return NextResponse.json({ error: message }, { status: 409 });
    if (message === "IMPLEMENTATION_WIP_LIMIT_REACHED") return NextResponse.json({ error: message }, { status: 409 });
    if (message === "STORY_SET_NOT_ACCEPTED") return NextResponse.json({ error: message }, { status: 409 });
    return NextResponse.json({ error: "IMPLEMENTATION_CONSENT_FAILED" }, { status: 500 });
  }
}

/** Customer ends an in-progress implementation card (frees the WIP=1 slot). */
const revokeSchema = z.object({ consentId: z.string().uuid() }).strict();
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { projectId } = await ctx.params;
    z.string().uuid().parse(projectId);
    if (!(await getProjectForCustomer(projectId))) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const { consentId } = revokeSchema.parse(await req.json());
    return NextResponse.json({ revoked: await revokeImplementation(projectId, consentId) });
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: "INVALID_IMPLEMENTATION_REVOKE" }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "";
    if (message === "UNAUTHENTICATED") return NextResponse.json({ error: message }, { status: 401 });
    if (message === "CONSENT_NOT_FOUND") return NextResponse.json({ error: message }, { status: 404 });
    return NextResponse.json({ error: "IMPLEMENTATION_REVOKE_FAILED" }, { status: 500 });
  }
}
