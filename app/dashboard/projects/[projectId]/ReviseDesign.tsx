'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {useAuthenticatedApiFetch} from '@/lib/providers/use-authenticated-api-fetch';

/** DC-03: shared "Revise" control for the Summary, DIR and stories pages. */
export default function ReviseDesign({projectId}:{projectId:string}) {
  const [confirming,setConfirming]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const apiFetch=useAuthenticatedApiFetch();
  const router=useRouter();
  async function revise(){
    setBusy(true);setError('');
    try{
      const r=await apiFetch(`/api/projects/${projectId}/design/versions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'revise'})});
      if(!r.ok)throw new Error('REVISE_FAILED');
      router.push(`/dashboard/projects/${projectId}/design`);
    }catch{setError('We could not start a new version. Please try again.');setBusy(false);}
  }
  return <section aria-label="Revise this design" style={{borderTop:'1px solid #ddd',marginTop:'1rem',paddingTop:'0.5rem'}}>
    {!confirming?<button type="button" onClick={()=>setConfirming(true)}>Revise design</button>:<>
      <p>Revising saves this version as it is (it will not change), cancels any test-build authorization for it, and reopens the design chat starting from your approved summary.</p>
      <button type="button" disabled={busy} onClick={revise}>{busy?'Starting new version…':'Start a new version'}</button>{' '}
      <button type="button" disabled={busy} onClick={()=>setConfirming(false)}>Cancel</button>
    </>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
