import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getProjectForCustomer } from '@/lib/design/repository';
import { approveDirDraft } from '@/lib/design/dir-repository';

export async function POST(req: Request, ctx: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await ctx.params;
    if (!z.string().uuid().safeParse(projectId).success || !(await getProjectForCustomer(projectId))) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    const body = z.object({ confirmed: z.literal(true), reviewedContent: z.record(z.unknown()) }).strict()
      .safeParse(await req.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: 'EXPLICIT_DIR_REVIEW_REQUIRED' }, { status: 400 });
    return NextResponse.json({ draft: await approveDirDraft(projectId, body.data.reviewedContent) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'UNAUTHENTICATED') return NextResponse.json({ error: message }, { status: 401 });
    if (message === 'DIR_REVIEW_MISMATCH_OR_MISSING') return NextResponse.json({ error: message }, { status: 409 });
    return NextResponse.json({ error: 'DIR_APPROVAL_FAILED' }, { status: 500 });
  }
}
