'use client';
import {useEffect,useState} from 'react';
import type {DirDraftContent} from '@/lib/design/dir-draft';
import {useAuthenticatedApiFetch} from '@/lib/providers/use-authenticated-api-fetch';
import ImplementationAuthorization from './ImplementationAuthorization';

type Story={id:string;as_a:string;i_want:string;so_that:string;gherkin:string;dir_refs?:{feature:string;persona:string;benefit:string};gp1p_action_id?:string};
type StorySet={status:'AI_DRAFT'|'accepted';stories:Story[];accepted_at?:string|null};

/** S07_01 (DIR §5.2): DIR -> Agile/BDD -> Kanban. The customer reviews and accepts the exact AI_DRAFT stories before
 *  any test-build authorization is offered. Changing the DIR regenerates the stories and requires a new acceptance. */
export default function StoryAcceptance({projectId,content}:{projectId:string;content:DirDraftContent}) {
  const [set,setSet]=useState<StorySet|null>(null);
  const [confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const apiFetch=useAuthenticatedApiFetch();
  useEffect(()=>{
    apiFetch(`/api/projects/${projectId}/stories`).then(async r=>{
      if(!r.ok)throw new Error('STORIES_UNAVAILABLE');
      setSet((await r.json()).storySet);
    }).catch(()=>setError('We could not load the stories for this design. Please refresh.'));
  },[projectId]);// eslint-disable-line react-hooks/exhaustive-deps
  async function accept(){
    if(!confirmed||busy||!set)return;
    setBusy(true);setError('');
    try{
      const r=await apiFetch(`/api/projects/${projectId}/stories`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({confirmed:true,reviewedStories:set.stories})});
      if(r.status===409){setError('These stories changed. Refresh and review them again.');return;}
      if(!r.ok)throw new Error('ACCEPT_FAILED');
      setSet({...set,status:'accepted'});
    }catch{setError('We could not save your acceptance. Please try again.');}
    finally{setBusy(false);}
  }
  if(error&&!set)return <p role="alert">{error}</p>;
  if(!set)return <p>Loading stories…</p>;
  return <>
    <section aria-label="Stories for this design">
      <h2>{set.status==='accepted'?'Stories accepted':'Review the stories'}</h2>
      <p>{set.status==='accepted'
        ?'These stories and their acceptance tests are on your build board.'
        :'AI_DRAFT: each must-have feature becomes a story with an acceptance test. Accepting them puts this design on the build board; it does not start a build.'}</p>
      {set.stories.map(s=><article key={s.id} style={{border:'1px solid #ddd',padding:'0.75rem',marginBottom:'0.5rem'}}>
        <h3>{s.id}: {s.i_want}</h3>
        <p>As a {s.as_a}, I want {s.i_want}, so that {s.so_that}.</p>
        <pre style={{whiteSpace:'pre-wrap',fontSize:13}}>{s.gherkin}</pre>
        {s.dir_refs&&<p style={{fontSize:12,color:'#555'}}>From your DIR: {s.dir_refs.feature}, {s.dir_refs.persona}, {s.dir_refs.benefit}{s.gp1p_action_id?` · build step ${s.gp1p_action_id}`:''}</p>}
      </article>)}
      {set.status!=='accepted'&&<>
        <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/> I have reviewed these stories and accept them for the build board.</label>
        <p><button disabled={!confirmed||busy} onClick={accept}>{busy?'Saving…':'Accept stories'}</button></p>
      </>}
      {error&&<p role="alert">{error}</p>}
    </section>
    {set.status==='accepted'&&<ImplementationAuthorization projectId={projectId} content={content}/>}
  </>;
}
