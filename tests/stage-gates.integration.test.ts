import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
// BDD_F07_01 (card S07_01): stage entry and exit artifacts per DIR §5.2; no stage can be skipped.
const identity=vi.hoisted(()=>({id:'00000000-0000-4000-8000-000000000001',clerk_user_id:'test_a'}));
vi.mock('@/lib/tenant/customer',()=>({requireCustomer:async()=>({...identity})}));
import {acceptStorySet,getStorySet,storiesFromDir} from '@/lib/design/stories';
import {authorizeImplementation} from '@/lib/design/implementation-consent';
import {recordCustomerReleaseDecision} from '@/lib/release/authorization';
import {POST as storiesPost} from '@/app/api/projects/[projectId]/stories/route';
import {closePgPools} from '@/lib/db/pg-sql';
import {mfaSession} from './helpers/operator-mfa';
// @ts-expect-error plain ESM script without types
import {agentGate} from '../scripts/agent-gate.mjs';
// @ts-expect-error plain ESM script without types
import {releaseAuthority} from '../scripts/release-authority.mjs';
const url=process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const P='00000000-0000-4000-8000-000000000011';
const R='rel-2026.11.14-57a6e5';const H='c'.repeat(64);
const DIR={status:'AI_DRAFT',sections:[
 {key:'problem_statement',title:'Problem statement',content:'Diners cannot book tables online'},
 {key:'users_personas',title:'Users / personas',content:'- Restaurant guest\n- Host'},
 {key:'must_have_features',title:'Must-have features',content:'- Book a table\n- Cancel a booking'},
 {key:'out_of_scope',title:'Out of scope',content:'Payments'}],governance:'x'};
const pass=JSON.stringify([{name:'unit_tests',status:'pass',evidence_sha256:H}]);
describe.skipIf(!url)('Stage gates (real PostgreSQL, app + operator logins)',()=>{
 let admin:Client;const urls:Record<string,string>={};const oldUrl=process.env.DATABASE_URL;
 const stage=async()=>(await admin.query('SELECT lifecycle_stage AS s FROM projects WHERE id=$1',[P])).rows[0].s as string;
 const gate=(...cmd:string[])=>agentGate(urls[cmd[0]],cmd.slice(1));
 const accept=async()=>{const s=await getStorySet(P);return acceptStorySet(P,s.stories);};
 beforeAll(async()=>{
  const parsed=new URL(url!);if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/nasi_audit')throw new Error('ISOLATED_LOCAL_DB_REQUIRED');
  admin=new Client({connectionString:url});await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for(const r of ['stg_app','stg_agent','stg_orch','stg_owner'])await admin.query(`DROP ROLE IF EXISTS ${r}`);
  for(const f of readdirSync(resolve('db/migrations')).filter(f=>f.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',f),'utf8'));
  const mk=async(name:string,role:string)=>{await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE ${role}`);
   const u=new URL(url!);u.username=name;u.password='local_audit_only';urls[name.replace('stg_','')]=u.toString();};
  await mk('stg_app','nasi_app_runtime');await mk('stg_agent','nasi_agent_runtime');await mk('stg_orch','nasi_deploy_orchestrator');await mk('stg_owner','nasi_platform_release_approver');
  await mfaSession(admin,urls.owner,'stg_owner'); // S02_01 operator MFA
  process.env.DATABASE_URL=urls.app;
 });
 beforeEach(async()=>{
  identity.id=A;identity.clerk_user_id='test_a';
  await admin.query('TRUNCATE customers CASCADE');
  await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'test_a'),($2,'test_b')",[A,B]);
  await admin.query("INSERT INTO projects(id,customer_id,name) VALUES($1,$2,'a')",[P,A]);
  await admin.query("INSERT INTO design_summaries(project_id,status,approved_at) VALUES($1,'approved',now())",[P]);
  await admin.query(`INSERT INTO dir_drafts(project_id,customer_id,status,content,source_summary,source_approved_at,generated_by,approved_at,approved_by)
   VALUES($1,$2,'approved',$3,'{}',now(),'test_a',now(),'test_a')`,[P,A,JSON.stringify(DIR)]);
  await admin.query("UPDATE projects SET lifecycle_stage='agile_bdd' WHERE id=$1",[P]);
 });
 afterAll(async()=>{await closePgPools();await admin?.end();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;});

 describe('DIR -> Agile/BDD exit artifact',()=>{
  it('derives one story with Gherkin per must-have feature, inventing nothing',()=>{
   const s=storiesFromDir(DIR);
   expect(s.map(x=>x.i_want)).toEqual(['Book a table','Cancel a booking']);
   expect(s[0]).toMatchObject({id:'ST01',as_a:'Restaurant guest',so_that:'Diners cannot book tables online'});
   expect(s[0].gherkin).toMatch(/^Feature: Book a table\n {2}Scenario: .+\n {4}Given .+\n {4}When .+\n {4}Then /);
   expect(()=>storiesFromDir({sections:[]})).toThrow('DIR_HAS_NO_FEATURES');
  });
  it('is an AI_DRAFT bound to the approved DIR digest, regenerated when the DIR changes',async()=>{
   const s=await getStorySet(P);expect(s.status).toBe('AI_DRAFT');
   await acceptStorySet(P,s.stories);
   const dir2={...DIR,sections:DIR.sections.map(x=>x.key==='must_have_features'?{...x,content:'- Book a table'}:x)};
   await admin.query('UPDATE dir_drafts SET content=$1',[JSON.stringify(dir2)]);
   const s2=await getStorySet(P);expect(s2.status).toBe('AI_DRAFT');expect(s2.stories).toHaveLength(1);
  });
 });

 describe('Agile/BDD -> Kanban: customer accepts the exact story set',()=>{
  it('moves to kanban only on acceptance of the reviewed stories',async()=>{
   const s=await getStorySet(P);
   await expect(acceptStorySet(P,[{id:'ST01',i_want:'something else'}])).rejects.toThrow('STORY_REVIEW_MISMATCH_OR_MISSING');
   expect(await stage()).toBe('agile_bdd');
   expect(await acceptStorySet(P,s.stories)).toMatchObject({status:'accepted',implementationAuthorized:false});
   expect(await stage()).toBe('kanban');
  });
  it('agents cannot accept stories (HITL)',async()=>{
   const s=await getStorySet(P);
   const r=await storiesPost(new Request('http://l/x',{method:'POST',headers:{'x-nasi-agent-token':'a'},body:JSON.stringify({confirmed:true,reviewedStories:s.stories})}),{params:Promise.resolve({projectId:P})});
   expect(r.status).toBe(403);expect(await stage()).toBe('agile_bdd');
  });
  it('another tenant cannot read or accept the story set',async()=>{
   await getStorySet(P);identity.id=B;identity.clerk_user_id='test_b';
   await expect(getStorySet(P)).rejects.toThrow('DIR_NOT_APPROVED');
   await expect(acceptStorySet(P,[{id:'ST01'}])).rejects.toThrow('STORY_REVIEW_MISMATCH_OR_MISSING');
  });
 });

 describe('no stage can be skipped (database-enforced)',()=>{
  it('Kanban -> Agentic: implementation consent refused before stories are accepted',async()=>{
   await expect(authorizeImplementation(P,DIR)).rejects.toThrow('STORY_SET_NOT_ACCEPTED');
   await expect(admin.query("INSERT INTO implementation_consents(project_id,customer_id,dir_sha256,approved_by) VALUES($1,$2,$3,'test_a')",[P,A,H])).rejects.toThrow(/STAGE_GATE_STORY_SET_NOT_ACCEPTED/);
   await accept();const c=await authorizeImplementation(P,DIR);expect(c.consent.id).toBeTruthy();expect(await stage()).toBe('agentic');
  });
  it('direct stage jumps are refused, even for the database owner',async()=>{
   for(const s of ['kanban','agentic','verification','staging','production'])
    await expect(admin.query('UPDATE projects SET lifecycle_stage=$1 WHERE id=$2',[s,P])).rejects.toThrow(/STAGE_GATE_/);
   await expect(admin.query("INSERT INTO projects(customer_id,name,lifecycle_stage) VALUES($1,'skip','production')",[A])).rejects.toThrow(/STAGE_GATE_/);
   await accept();
   await expect(admin.query("UPDATE projects SET lifecycle_stage='verification' WHERE id=$1",[P])).rejects.toThrow(/STAGE_GATE_VERIFICATION_PACKAGE_NOT_PASSED/);
  });
  it('a changed DIR invalidates the accepted stories, closing the gate again',async()=>{
   await accept();await admin.query("UPDATE dir_drafts SET content=jsonb_set(content,'{governance}','\"changed\"')");
   await expect(authorizeImplementation(P,{...DIR,governance:'changed'})).rejects.toThrow('STORY_SET_NOT_ACCEPTED');
  });
  it('full path: each exit artifact advances exactly one stage; production needs a staging release of that version',async()=>{
   await accept();expect(await stage()).toBe('kanban');
   const consent=(await authorizeImplementation(P,DIR)).consent.id as string;expect(await stage()).toBe('agentic');
   await gate('agent','package',P,consent,R,JSON.stringify([{name:'unit_tests',status:'fail',evidence_sha256:H}]));expect(await stage()).toBe('agentic');
   await gate('agent','package',P,consent,R,pass);expect(await stage()).toBe('verification');
   await recordCustomerReleaseDecision(P,R,'approved');await releaseAuthority(urls.owner,['platform','approve',P,R,'Platform checks green, change window open']);
   await expect(releaseAuthority(urls.orch,['credential',P,R])).rejects.toThrow(/STAGE_GATE_STAGING_RELEASE_MISSING/);
   expect(await stage()).toBe('verification');
   expect(await gate('orch','staging',P,R)).toMatchObject({staging:'PROMOTED'});expect(await stage()).toBe('staging');
   const t=await releaseAuthority(urls.orch,['credential',P,R]);expect(await stage()).toBe('staging');
   expect(await releaseAuthority(urls.orch,['redeem',t.token])).toMatchObject({deploy:'AUTHORIZED'});expect(await stage()).toBe('production');
  });
  it('the app role cannot move a project forward without the artifacts',async()=>{
   const c=new Client({connectionString:urls.app});await c.connect();
   try{
    await c.query('BEGIN');await c.query("SELECT set_config('app.current_customer_id',$1,true)",[A]);
    await expect(c.query("UPDATE projects SET lifecycle_stage='staging' WHERE id=$1",[P])).rejects.toThrow(/STAGE_GATE_/);
    await c.query('ROLLBACK');
    await expect(c.query('SELECT advance_stage($1,$2)',[P,'production'])).rejects.toThrow(/permission denied/);
   }finally{await c.end();}
  });
 });
});
