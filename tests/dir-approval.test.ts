import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ project: vi.fn(), approve: vi.fn() }));
vi.mock('@/lib/design/repository', () => ({ getProjectForCustomer: mocks.project }));
vi.mock('@/lib/design/dir-repository', () => ({ approveDirDraft: mocks.approve }));
import { POST } from '@/app/api/projects/[projectId]/dir/approve/route';
const id = '00000000-0000-4000-8000-000000000001';
const ctx = { params: Promise.resolve({ projectId: id }) };
const content = { sections: [{ content: 'Reviewed scope' }] };
const req = (body: unknown) => new Request('http://localhost/approve', { method: 'POST', body: JSON.stringify(body) });
describe('Explicit customer DIR approval HTTP boundary', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.project.mockResolvedValue({ id }); });
  it.each([{}, { confirmed: false, reviewedContent: content }, { confirmed: true }, { confirmed: true, reviewedContent: content, actor: 'agent' }])('requires explicit review and rejects caller-supplied authority', async body => {
    expect((await POST(req(body), ctx)).status).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it('passes the reviewed snapshot to the authenticated repository', async () => {
    mocks.approve.mockResolvedValue({ status: 'approved', approved_by: 'customer' });
    expect((await POST(req({ confirmed: true, reviewedContent: content }), ctx)).status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith(id, content);
  });
  it('denies other customers before approval', async () => {
    mocks.project.mockResolvedValue(null);
    expect((await POST(req({ confirmed: true, reviewedContent: content }), ctx)).status).toBe(404);
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it('requires authentication', async () => {
    mocks.project.mockRejectedValue(new Error('UNAUTHENTICATED'));
    expect((await POST(req({}), ctx)).status).toBe(401);
  });
  it('fails closed for missing or changed drafts', async () => {
    mocks.approve.mockRejectedValue(new Error('DIR_REVIEW_MISMATCH_OR_MISSING'));
    expect((await POST(req({ confirmed: true, reviewedContent: content }), ctx)).status).toBe(409);
  });
  it('hides internal failures', async () => {
    mocks.approve.mockRejectedValue(new Error('secret'));
    const response = await POST(req({ confirmed: true, reviewedContent: content }), ctx);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'DIR_APPROVAL_FAILED' });
  });
});
