import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
// BDD_F07_02 (WIP=1 per project) and BDD_F10_01 / BDD_F10_02 (meters, fail-closed caps).
const identity=vi.hoisted(()=>({id:'00000000-0000-4000-8000-000000000001',clerk_user_id:'test_a'}));
vi.mock('@/lib/tenant/customer',()=>({requireCustomer:async()=>({...identity})}));
const ai=vi.hoisted(()=>({calls:0}));
vi.mock('@/lib/design/openai',()=>({
 getDesignAssistantMode:()=>'local_stub',
 generateDesignAssistantReply:async()=>{ai.calls++;return {content:'reply',isAiDraft:true,proposals:{},tokensUsed:1234};},
}));
import {authorizeImplementation,revokeImplementation} from '@/lib/design/implementation-consent';
import {assertDesignTokensAvailable,assertProjectUsageAvailable,getUsageForProject,recordProjectUsage} from '@/lib/usage/repository';
import {BETA_CAPS,UsageCapExceededError} from '@/lib/usage/meters';
import {POST as postMessage} from '@/app/api/projects/[projectId]/design/messages/route';
import {closePgPools} from '@/lib/db/pg-sql';
const url=process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const P='00000000-0000-4000-8000-000000000011',Q='00000000-0000-4000-8000-000000000012';
const content={sections:[{content:'Customer reviewed nonproduction scope'}]};
const asB=()=>{identity.id=B;identity.clerk_user_id='test_b';};
const send=(text:string)=>postMessage(new Request('http://local/x',{method:'POST',body:JSON.stringify({message:text})}),{params:Promise.resolve({projectId:P})});
describe.skipIf(!url)('WIP limit and usage caps (real PostgreSQL, least-privilege runtime role)',()=>{
 let admin:Client;let app:Client;const oldUrl=process.env.DATABASE_URL;
 beforeAll(async()=>{
  const parsed=new URL(url!);if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/nasi_audit')throw new Error('ISOLATED_LOCAL_DB_REQUIRED');
  admin=new Client({connectionString:url});await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP ROLE IF EXISTS nasi_usage_app');
  for(const n of readdirSync(resolve('db/migrations')).filter(n=>n.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',n),'utf8'));
  await admin.query("CREATE ROLE nasi_usage_app LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE nasi_app_runtime");
  parsed.username='nasi_usage_app';parsed.password='local_audit_only';process.env.DATABASE_URL=parsed.toString();
  app=new Client({connectionString:parsed.toString()});await app.connect();
 });
 beforeEach(async()=>{
  identity.id=A;identity.clerk_user_id='test_a';ai.calls=0;
  await admin.query('TRUNCATE usage_meter_events,implementation_consents,dir_drafts,design_summaries,design_messages,projects,customers CASCADE');
  await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'test_a'),($2,'test_b')",[A,B]);
  await admin.query("INSERT INTO projects(id,customer_id,name) VALUES($1,$2,'a'),($3,$4,'b')",[P,A,Q,B]);
  await admin.query("INSERT INTO dir_drafts(project_id,customer_id,status,content,source_summary,source_approved_at,generated_by,approved_at,approved_by) VALUES($1,$2,'approved',$3,'{}',now(),'test_a',now(),'test_a')",[P,A,JSON.stringify(content)]);
 });
 afterAll(async()=>{await closePgPools();await app?.end();await admin?.end();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;});

 describe('BDD_F07_02 max one implementation card in progress per project',()=>{
  it('denies a second in-progress card until the first is revoked',async()=>{
   const first=await authorizeImplementation(P,content);
   await expect(authorizeImplementation(P,content)).rejects.toThrow('IMPLEMENTATION_WIP_LIMIT_REACHED');
   await revokeImplementation(P,first.consent.id as string);
   await expect(authorizeImplementation(P,content)).resolves.toBeTruthy();
  });
  it('frees the slot when the in-progress card expires',async()=>{
   await authorizeImplementation(P,content);
   await admin.query("UPDATE implementation_consents SET granted_at=now()-interval '2 hours',expires_at=now()-interval '1 hour'");
   await expect(authorizeImplementation(P,content)).resolves.toBeTruthy();
  });
  it('lets exactly one of ten concurrent requests through',async()=>{
   const results=await Promise.allSettled(Array.from({length:10},()=>authorizeImplementation(P,content)));
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
   expect((await admin.query('SELECT count(*)::int AS n FROM implementation_consents')).rows[0].n).toBe(1);
  });
  it('honours a customer-raised limit',async()=>{
   await admin.query('UPDATE projects SET implementation_wip_limit=2 WHERE id=$1',[P]);
   await authorizeImplementation(P,content);await authorizeImplementation(P,content);
   await expect(authorizeImplementation(P,content)).rejects.toThrow('IMPLEMENTATION_WIP_LIMIT_REACHED');
  });
  it('does not let another customer revoke or see the WIP state',async()=>{
   const r=await authorizeImplementation(P,content);asB();
   await expect(revokeImplementation(P,r.consent.id as string)).rejects.toThrow('CONSENT_NOT_FOUND');
   await expect(authorizeImplementation(P,content)).rejects.toThrow('APPROVED_DIR_REVIEW_MISMATCH');
  });
 });

 describe('BDD_F10_01 meters for tokens, agent minutes and deploy counts',()=>{
  it('reports usage against every approved cap',async()=>{
   await recordProjectUsage(P,'design_tokens',500,'test');await recordProjectUsage(P,'agent_minutes',30,'test');
   await recordProjectUsage(P,'staging_deploys',2,'test');await recordProjectUsage(P,'production_deploys',1,'test');
   const u=Object.fromEntries((await getUsageForProject(P)).map(m=>[m.meter,[m.used,m.limit,m.exceeded]]));
   expect(u).toEqual({design_tokens:[500,750000,false],agent_minutes:[30,180,false],staging_deploys:[2,15,false],production_deploys:[1,3,false]});
  });
  it('counts only the current calendar month',async()=>{
   await admin.query("INSERT INTO usage_meter_events(customer_id,meter,quantity,source,occurred_at) VALUES($1,'design_tokens',999999,'old',date_trunc('month',now())-interval '1 day')",[A]);
   await expect(assertDesignTokensAvailable()).resolves.toEqual({used:0,limit:750000});
  });
  it('keeps meters tenant-scoped and append-only for the runtime role',async()=>{
   await recordProjectUsage(P,'design_tokens',10,'test');asB();
   expect((await getUsageForProject(Q)).find(m=>m.meter==='design_tokens')?.used).toBe(0);
   await expect(recordProjectUsage(P,'agent_minutes',5,'test')).rejects.toThrow(/row-level security/);
   await expect(app.query('DELETE FROM usage_meter_events')).rejects.toThrow(/permission denied/);
   await expect(app.query('UPDATE usage_meter_events SET quantity=1')).rejects.toThrow(/permission denied/);
  });
 });

 describe('BDD_F10_02 halt generative and agentic calls at the cap',()=>{
  it('GPT halted at token cap: API returns cap exceeded and no model call is made',async()=>{
   await recordProjectUsage(P,'design_tokens',BETA_CAPS.design_tokens.limit,'test');
   const res=await send('hello');
   expect(res.status).toBe(429);expect((await res.json()).error).toBe('USAGE_CAP_EXCEEDED');
   expect(ai.calls).toBe(0);
   expect((await admin.query('SELECT count(*)::int AS n FROM design_messages')).rows[0].n).toBe(0);
  });
  it('meters the tokens of an allowed design chat call',async()=>{
   const res=await send('hello');expect(res.status).toBe(200);expect(ai.calls).toBe(1);
   expect((await getUsageForProject(P)).find(m=>m.meter==='design_tokens')?.used).toBe(1234);
  });
  it('halts agentic and deploy steps at their per-project caps',async()=>{
   await recordProjectUsage(P,'agent_minutes',180,'test');await recordProjectUsage(P,'production_deploys',3,'test');
   await expect(assertProjectUsageAvailable(P,'agent_minutes')).rejects.toBeInstanceOf(UsageCapExceededError);
   await expect(assertProjectUsageAvailable(P,'production_deploys')).rejects.toBeInstanceOf(UsageCapExceededError);
   await expect(assertProjectUsageAvailable(P,'staging_deploys')).resolves.toEqual({used:0,limit:15});
  });
 });
});
