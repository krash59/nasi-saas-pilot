import { NextResponse } from "next/server";
import {
  approveDesignSummary,
  confirmSummaryField,
  getOrCreateSummary,
  getProjectForCustomer,
  getProjectStageInfo,
} from "@/lib/design/repository";
import { SUMMARY_FIELD_KEYS, type SummaryFieldKey } from "@/lib/design/summary-fields";
import { denyAgenticWithoutApprovedSummary } from "@/lib/design/stage-gate";
import { z } from "zod";
import { generateDirDraft } from "@/lib/design/dir-repository";
import { authorizeImplementation, revokeImplementation } from "@/lib/design/implementation-consent";

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
  customer_confirmed: z.string().min(1),
  ai_proposed: z.string().optional(),
}).strict();

const approveSchema = z.object({ action: z.literal("approve") }).strict();

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
    const parsed = confirmSchema.parse(body);
    const fields = await confirmSummaryField(
      projectId,
      parsed.field,
      parsed.customer_confirmed,
      parsed.ai_proposed,
    );
    return NextResponse.json({ fields });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: msg }, { status: 401 });
    if (e instanceof z.ZodError || e instanceof SyntaxError) {
      return NextResponse.json({ error: "INVALID_SUMMARY_REQUEST" }, { status: 400 });
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
    return NextResponse.json(await authorizeImplementation(projectId, body.reviewedContent), { status: 201 });
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
