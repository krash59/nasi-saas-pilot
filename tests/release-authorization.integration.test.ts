import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
// BDD_F09_01 ACT_05A, BDD_F09_02 ACT_05B, BDD_F09_03 dual production deploy gate; BDD_F08_01 agent blocked.
const identity=vi.hoisted(()=>({id:'00000000-0000-4000-8000-000000000001',clerk_user_id:'test_a'}));
vi.mock('@/lib/tenant/customer',()=>({requireCustomer:async()=>({...identity})}));
import {getReleaseStatus,recordCustomerReleaseDecision} from '@/lib/release/authorization';
import {POST as releasePost} from '@/app/api/projects/[projectId]/release-authorization/route';
import {closePgPools} from '@/lib/db/pg-sql';
import {mfaSession} from './helpers/operator-mfa';
// @ts-expect-error plain ESM script without types
import {releaseAuthority} from '../scripts/release-authority.mjs';
const url=process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const P='00000000-0000-4000-8000-000000000011',Q='00000000-0000-4000-8000-000000000012';
const R='rel-2026.11.14-a1b2c3d';const WHY='Platform checks green, change window open';
describe.skipIf(!url)('Dual production authorization (real PostgreSQL, separate logins)',()=>{
 let admin:Client;const urls:Record<string,string>={};const oldUrl=process.env.DATABASE_URL;
 const as=(who:string,...cmd:string[])=>releaseAuthority(urls[who],cmd);
 const n=async(sql:string)=>Number((await admin.query(sql)).rows[0].n);
 const both=async()=>{await recordCustomerReleaseDecision(P,R,'approved');await as('owner','platform','approve',P,R,WHY);};
 beforeAll(async()=>{
  const parsed=new URL(url!);if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/nasi_audit')throw new Error('ISOLATED_LOCAL_DB_REQUIRED');
  admin=new Client({connectionString:url});await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP ROLE IF EXISTS rel_app; DROP ROLE IF EXISTS rel_owner; DROP ROLE IF EXISTS rel_orch');
  for(const f of readdirSync(resolve('db/migrations')).filter(f=>f.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',f),'utf8'));
  const mk=async(name:string,role:string)=>{await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE ${role}`);
   const u=new URL(url!);u.username=name;u.password='local_audit_only';urls[name.replace('rel_','')]=u.toString();};
  await mk('rel_app','nasi_app_runtime');await mk('rel_owner','nasi_platform_release_approver');await mk('rel_orch','nasi_deploy_orchestrator');
  await mfaSession(admin,urls.owner,'rel_owner'); // S02_01 operator MFA
  process.env.DATABASE_URL=urls.app;
 });
 beforeEach(async()=>{
  identity.id=A;identity.clerk_user_id='test_a';
  await admin.query('TRUNCATE staging_promotions,verification_packages,agent_halts,production_deploy_decisions,production_deploy_credentials,platform_production_authorizations,customer_release_authorizations,usage_meter_events,dir_drafts,projects,customers CASCADE');
  await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'test_a'),($2,'test_b')",[A,B]);
  await admin.query("INSERT INTO projects(id,customer_id,name) VALUES($1,$2,'a'),($3,$4,'b')",[P,A,Q,B]);
  await admin.query("INSERT INTO dir_drafts(project_id,customer_id,status,content,source_summary,source_approved_at,generated_by,approved_at,approved_by) VALUES($1,$2,'approved','{}','{}',now(),'test_a',now(),'test_a')",[P,A]);
  // BDD_F15_01 (migration 014): production also needs a passed verification package for the release.
  await admin.query(`INSERT INTO verification_packages(project_id,customer_id,release_ref,checks,passed,evidence_sha256,submitted_by)
   VALUES($1,$2,$3,'[{"name":"unit_tests","status":"pass"}]',true,repeat('a',64),'fixture')`,[P,A,R]);
  // BDD_F07_01 (migration 015): production credentials only for a release promoted to staging.
  await admin.query("INSERT INTO staging_promotions(project_id,customer_id,release_ref,outcome,reason,requested_by) VALUES($1,$2,$3,'PROMOTED','fixture','fixture')",[P,A,R]);
 });
 afterAll(async()=>{await closePgPools();await admin?.end();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;});

 describe('BDD_F09_01 ACT_05A Customer Release Authorization',()=>{
  it('records the customer decision for one exact release, never granting production by itself',async()=>{
   const r=await recordCustomerReleaseDecision(P,R,'approved');
   expect(r.productionReleaseAuthorized).toBe(false);expect(r.authorization).toMatchObject({release_ref:R,decision:'approved'});
   expect((await getReleaseStatus(P,R)).customer).toMatchObject({decision:'approved'});
  });
  it('requires an approved DIR and the project owner',async()=>{
   await admin.query("UPDATE dir_drafts SET status='AI_DRAFT',approved_at=NULL,approved_by=NULL");
   await expect(recordCustomerReleaseDecision(P,R,'approved')).rejects.toThrow('DIR_NOT_APPROVED');
   identity.id=B;identity.clerk_user_id='test_b';
   await expect(recordCustomerReleaseDecision(P,R,'approved')).rejects.toThrow();
   expect(await n('SELECT count(*)::int AS n FROM customer_release_authorizations')).toBe(0);
  });
 });

 describe('BDD_F09_02 ACT_05B Platform Production Authorization',()=>{
  it('is recorded only by a platform release approver login, with reason',async()=>{
   const r=await as('owner','platform','approve',P,R,WHY);expect(r.decision).toBe('approved');
   expect((await admin.query('SELECT decided_by FROM platform_production_authorizations')).rows).toEqual([{decided_by:'rel_owner'}]);
   await expect(as('orch','platform','approve',P,R,WHY)).rejects.toThrow(/permission denied|NOT_PLATFORM_RELEASE_APPROVER/);
   await expect(as('owner','platform','approve',P,R,'short')).rejects.toThrow();
  });
  it('cannot be written by the customer app role',async()=>{
   const c=new Client({connectionString:urls.app});await c.connect();
   try{
    await expect(c.query("INSERT INTO platform_production_authorizations(project_id,customer_id,release_ref,decision,decided_by,reason) VALUES($1,$2,$3,'approved','me','forged approval here')",[P,A,R])).rejects.toThrow(/permission denied/);
    await expect(c.query('SELECT record_platform_production_authorization($1,$2,$3,$4)',[P,R,'approved',WHY])).rejects.toThrow(/permission denied/);
    await expect(c.query('SELECT issue_production_deploy_credential($1,$2)',[P,R])).rejects.toThrow(/permission denied/);
    await expect(c.query("UPDATE customer_release_authorizations SET decision='approved'")).rejects.toThrow(/permission denied/);
   }finally{await c.end();}
  });
 });

 describe('BDD_F09_03 dual production deploy gate',()=>{
  it('Deploy blocked with only customer authorization: request denied, no credential issued',async()=>{
   await recordCustomerReleaseDecision(P,R,'approved');
   expect(await as('orch','credential',P,R)).toEqual({denied:'PLATFORM_PRODUCTION_AUTHORIZATION_MISSING'});
   expect(await n('SELECT count(*)::int AS n FROM production_deploy_credentials')).toBe(0);
  });
  it('blocked with only platform authorization',async()=>{
   await as('owner','platform','approve',P,R,WHY);
   expect(await as('orch','credential',P,R)).toEqual({denied:'CUSTOMER_RELEASE_AUTHORIZATION_MISSING'});
  });
  it('issues a single-use, hashed, short-lived credential when both are valid',async()=>{
   await both();const r=await as('orch','credential',P,R);
   expect(r.token).toMatch(/^nasi_deploy_[a-f0-9]{64}$/);
   expect(await n(`SELECT count(*)::int AS n FROM production_deploy_credentials WHERE token_sha256=encode(digest('${r.token}','sha256'),'hex') AND expires_at<=now()+interval '15 minutes'`)).toBe(1);
   expect(await n(`SELECT count(*)::int AS n FROM production_deploy_credentials WHERE token_sha256='${r.token}'`)).toBe(0);
   expect(await as('orch','redeem',r.token)).toMatchObject({deploy:'AUTHORIZED'});
   expect(await as('orch','redeem',r.token)).toEqual({denied:'CREDENTIAL_ALREADY_USED'});
   expect(await n("SELECT count(*)::int AS n FROM usage_meter_events WHERE meter='production_deploys'")).toBe(1);
  });
  it('Either party blocks deploy: customer rejection after both approvals denies',async()=>{
   await both();const early=await as('orch','credential',P,R);
   await recordCustomerReleaseDecision(P,R,'rejected');
   expect(await as('orch','credential',P,R)).toEqual({denied:'CUSTOMER_RELEASE_REJECTED'});
   expect(await as('orch','redeem',early.token)).toEqual({denied:'CUSTOMER_RELEASE_NO_LONGER_VALID'});
  });
  it('platform rejection also blocks',async()=>{
   await both();await as('owner','platform','reject',P,R,'Incident in progress, freeze');
   expect(await as('orch','credential',P,R)).toEqual({denied:'PLATFORM_PRODUCTION_REJECTED'});
  });
  it('expired approvals and a different release fail closed',async()=>{
   await both();
   expect(await as('orch','credential',P,'rel-other-9999999')).toEqual({denied:'CUSTOMER_RELEASE_AUTHORIZATION_MISSING'});
   await admin.query("UPDATE customer_release_authorizations SET expires_at=now()-interval '1 second'");
   expect(await as('orch','credential',P,R)).toEqual({denied:'CUSTOMER_RELEASE_AUTHORIZATION_EXPIRED'});
  });
  it('stops at the production deploy cap (3 per project per month)',async()=>{
   await both();
   for(let i=0;i<3;i++){const t=await as('orch','credential',P,R);expect((await as('orch','redeem',t.token)).deploy).toBe('AUTHORIZED');}
   expect(await as('orch','credential',P,R)).toEqual({denied:'PRODUCTION_DEPLOY_CAP_REACHED'});
  });
  it('logs every decision and shows it to the customer only',async()=>{
   await recordCustomerReleaseDecision(P,R,'approved');await as('orch','credential',P,R);await as('owner','platform','approve',P,R,WHY);await as('orch','credential',P,R);
   expect((await getReleaseStatus(P,R)).deploy_log.map(l=>l.outcome)).toEqual(['DENIED','ISSUED']);
   identity.id=B;identity.clerk_user_id='test_b';
   expect((await getReleaseStatus(P,R)).deploy_log).toEqual([]);
  });
 });

 describe('BDD_F08_01 agent cannot approve HITL',()=>{
  it('agent service identity calling the production authorization endpoint is forbidden and creates no ACT_05A/05B record',async()=>{
   const r=await releasePost(new Request('http://local/x',{method:'POST',headers:{'x-nasi-agent-token':'agent-1'},body:JSON.stringify({confirmed:true,releaseRef:R,decision:'approved'})}),{params:Promise.resolve({projectId:P})});
   expect(r.status).toBe(403);expect((await r.json()).error).toBe('AGENT_HITL_FORBIDDEN');
   expect(await n('SELECT count(*)::int AS n FROM customer_release_authorizations')).toBe(0);
   expect(await n('SELECT count(*)::int AS n FROM platform_production_authorizations')).toBe(0);
  });
 });
});
