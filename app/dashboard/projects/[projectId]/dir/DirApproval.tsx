'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DirDraftContent } from '@/lib/design/dir-draft';
import { useAuthenticatedApiFetch } from '@/lib/providers/use-authenticated-api-fetch';

export default function DirApproval({ projectId, content }: { projectId: string; content: DirDraftContent }) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();
  const apiFetch = useAuthenticatedApiFetch();
  async function approve() {
    setBusy(true); setError('');
    try {
      const res = await apiFetch(`/api/projects/${projectId}/dir/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed, reviewedContent: content }),
      });
      if (!res.ok) throw new Error('Approval failed. Refresh to review the current draft and try again.');
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Approval failed.'); }
    finally { setBusy(false); }
  }
  return <section>
    <p>DIR approval allows the Agile/BDD planning stage. Implementation requires separate authorization.</p>
    <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} /> I have reviewed this DIR and approve its design and scope.</label>
    <p><button disabled={!confirmed || busy} onClick={approve}>{busy ? 'Approving…' : 'Approve DIR'}</button></p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
