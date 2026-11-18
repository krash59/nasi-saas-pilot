'use client';
import {useState} from 'react';
import type {DirDraftContent} from '@/lib/design/dir-draft';
import {useAuthenticatedApiFetch} from '@/lib/providers/use-authenticated-api-fetch';

export default function ImplementationAuthorization({projectId,content}:{projectId:string;content:DirDraftContent}) {
  const [confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [expiresAt,setExpiresAt]=useState<string|null>(null);
  const [handoff,setHandoff]=useState<{job_sha256:string;received_at?:string|null}|null>(null);
  const [sendError,setSendError]=useState('');
  const apiFetch=useAuthenticatedApiFetch();
  async function authorize(){
    if(!confirmed||busy)return;
    setBusy(true);setError('');
    try {
      const response=await apiFetch(`/api/projects/${projectId}/design/summary`,{
        method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:true,reviewedContent:content}),
      });
      if(response.status===409){setError('This design changed. Refresh and review it before authorizing a test build.');return;}
      if(!response.ok)throw new Error('AUTHORIZATION_FAILED');
      const body=await response.json();
      if(body.consent?.implementation_scope!=='nonproduction'||body.nwsExecutionAuthorized!==false||body.productionReleaseAuthorized!==false||!Number.isFinite(Date.parse(body.consent.expires_at)))throw new Error('INVALID_AUTHORIZATION_RESPONSE');
      setExpiresAt(body.consent.expires_at);
      setHandoff(body.nwsHandoff??null);
    }catch{setError('We could not save your authorization. Please try again.');}
    finally{setBusy(false);}
  }
  async function resend(){
    setSendError('');
    try{
      const r=await apiFetch(`/api/projects/${projectId}/nws-handoff/job`,{method:'POST'});
      if(!r.ok)throw new Error('SEND_FAILED');
      setHandoff((await r.json()).handoff);
    }catch{setSendError('We could not send the build job yet. Please try again.');}
  }
  if(expiresAt)return <section aria-label="Test build authorization"><h2>Test build authorized</h2><p>Your approval covers this reviewed design version in the test environment, until {new Date(expiresAt).toLocaleString()}.</p>
    <section aria-label="NWS build job">{handoff
      ?<p>Sent to NWS: your approved design, accepted stories and this authorization (job {handoff.job_sha256.slice(0,12)}). {handoff.received_at?'NWS has confirmed receipt.':'Waiting for NWS to confirm receipt.'}</p>
      :<p>The build job has not been sent yet. <button type="button" onClick={resend}>Send to NWS</button></p>}
      {sendError&&<p role="alert">{sendError}</p>}</section></section>;
  return <section aria-label="Test build authorization">
    <h2>Authorize a test build</h2>
    <p>This approval covers the design shown above in the test environment. A changed design needs a new review. It does not approve a production release.</p>
    <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/> I authorize a test build of this reviewed design.</label>
    <p><button disabled={!confirmed||busy} onClick={authorize}>{busy?'Saving authorization…':'Authorize test build'}</button></p>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
