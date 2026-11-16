import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
// BDD_F06_01 time-bounded break-glass with audit logs (DIR §8.4 §9.1, RACI ACT_08, RET_D03).
const identity=vi.hoisted(()=>({id:'00000000-0000-4000-8000-000000000001',clerk_user_id:'test_a'}));
vi.mock('@/lib/tenant/customer',()=>({requireCustomer:async()=>({...identity})}));
import {listBreakGlassForCustomer} from '@/lib/account/break-glass';
import {exportCustomerData} from '@/lib/account/export';
import {closePgPools} from '@/lib/db/pg-sql';
import {mfaSession} from './helpers/operator-mfa';
// @ts-expect-error plain ESM script without types
import {breakGlass} from '../scripts/break-glass.mjs';
// @ts-expect-error plain ESM script without types
import {runRetentionPurge} from '../scripts/retention-purge.mjs';
const url=process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const PA='00000000-0000-4000-8000-000000000011',PB='00000000-0000-4000-8000-000000000012';
const REASON='Customer ticket 42: summary will not load';
describe.skipIf(!url)('Break-glass (real PostgreSQL, separate operator logins)',()=>{
 let admin:Client;const urls:Record<string,string>={};const oldUrl=process.env.DATABASE_URL;
 const as=(who:string,...cmd:string[])=>breakGlass(urls[who],cmd);
 const log=async(g:string)=>(await admin.query('SELECT actor,action FROM break_glass_access_log WHERE grant_id=$1 ORDER BY at,action',[g])).rows;
 const approved=async()=>{const {grant}=await as('eng','request',PA,'15',REASON);await as('owner','approve',grant);return grant as string;};
 beforeAll(async()=>{
  const parsed=new URL(url!);if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/nasi_audit')throw new Error('ISOLATED_LOCAL_DB_REQUIRED');
  admin=new Client({connectionString:url});await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP ROLE IF EXISTS bg_eng; DROP ROLE IF EXISTS bg_eng2; DROP ROLE IF EXISTS bg_owner; DROP ROLE IF EXISTS bg_both; DROP ROLE IF EXISTS bg_app; DROP ROLE IF EXISTS bg_purge');
  for(const f of readdirSync(resolve('db/migrations')).filter(f=>f.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',f),'utf8'));
  const mk=async(name:string,roles:string)=>{await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE ${roles}`);
   const u=new URL(url!);u.username=name;u.password='local_audit_only';urls[name.replace('bg_','')]=u.toString();};
  await mk('bg_eng','nasi_break_glass');await mk('bg_eng2','nasi_break_glass');await mk('bg_owner','nasi_break_glass_approver');
  await mk('bg_both','nasi_break_glass, nasi_break_glass_approver');await mk('bg_app','nasi_app_runtime');await mk('bg_purge','nasi_retention_purge');
  for(const who of ['eng','eng2','owner','both'])await mfaSession(admin,urls[who],'bg_'+who); // S02_01 operator MFA
  process.env.DATABASE_URL=urls.app;
 });
 beforeEach(async()=>{
  identity.id=A;identity.clerk_user_id='test_a';
  await admin.query('TRUNCATE break_glass_access_log,break_glass_grants,retention_purge_runs,security_audit_events,design_messages,projects,customers CASCADE');
  await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'test_a'),($2,'test_b')",[A,B]);
  await admin.query("INSERT INTO projects(id,customer_id,name) VALUES($1,$2,'a'),($3,$4,'b')",[PA,A,PB,B]);
  await admin.query("INSERT INTO design_messages(project_id,role,content,is_ai_draft) VALUES($1,'customer','A private idea',false)",[PA]);
 });
 afterAll(async()=>{await closePgPools();await admin?.end();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;});

 it('requires owner approval from a different login before any read, then logs the read',async()=>{
  const {grant,status}=await as('eng','request',PA,'15',REASON);expect(status).toBe('PENDING_OWNER_APPROVAL');
  await expect(as('eng','read',grant)).rejects.toThrow('BREAK_GLASS_ACCESS_DENIED');
  await expect(as('eng','approve',grant)).rejects.toThrow(/permission denied for function break_glass_approve|NOT_BREAK_GLASS_APPROVER/);
  const {expires_at}=await as('owner','approve',grant);
  expect(new Date(expires_at).getTime()-Date.now()).toBeGreaterThan(14*60_000);expect(new Date(expires_at).getTime()-Date.now()).toBeLessThanOrEqual(15*60_000);
  const content=await as('eng','read',grant);
  expect(content.design_messages.map((m:{content:string})=>m.content)).toEqual(['A private idea']);
  expect(await log(grant)).toEqual([{actor:'bg_eng',action:'REQUESTED'},{actor:'bg_eng',action:'ACCESS_DENIED'},{actor:'bg_owner',action:'APPROVED'},{actor:'bg_eng',action:'CONTENT_READ'}]);
 });
 it('one person holding both roles cannot approve their own request',async()=>{
  const {grant}=await as('both','request',PA,'10',REASON);
  await expect(as('both','approve',grant)).rejects.toThrow('APPROVER_MUST_DIFFER_FROM_ENGINEER');
 });
 it('is time-bounded: max 60 minutes, denied and logged after expiry or close',async()=>{
  await expect(as('eng','request',PA,'61',REASON)).rejects.toThrow();
  await expect(as('eng','request',PA,'10','short')).rejects.toThrow();
  const g=await approved();
  await admin.query("UPDATE break_glass_grants SET requested_at=now()-interval '2 hours',approved_at=now()-interval '1 hour',expires_at=now()-interval '45 minutes' WHERE id=$1",[g]);
  await expect(as('eng','read',g)).rejects.toThrow('BREAK_GLASS_ACCESS_DENIED');
  const g2=await approved();expect((await as('eng','close',g2)).closed).toBe(true);
  await expect(as('eng','read',g2)).rejects.toThrow('BREAK_GLASS_ACCESS_DENIED');
  expect((await log(g2)).map(r=>r.action)).toEqual(['REQUESTED','APPROVED','CLOSED','ACCESS_DENIED']);
 });
 it('only the requesting engineer can read under the grant',async()=>{
  const g=await approved();
  await expect(as('eng2','read',g)).rejects.toThrow('BREAK_GLASS_ACCESS_DENIED');
  expect((await log(g)).at(-1)).toEqual({actor:'bg_eng2',action:'ACCESS_DENIED'});
 });
 it('notifies the affected customer only, and includes it in their export',async()=>{
  const g=await approved();await as('eng','read',g);
  const seen=await listBreakGlassForCustomer();
  expect(seen).toHaveLength(1);expect(seen[0]).toMatchObject({id:g,engineer:'bg_eng',approver:'bg_owner',reason:REASON});
  expect(seen[0].log.map(l=>l.action)).toContain('CONTENT_READ');
  expect((await exportCustomerData()).break_glass).toHaveLength(1);
  identity.id=B;identity.clerk_user_id='test_b';expect(await listBreakGlassForCustomer()).toEqual([]);
 });
 it('withholds notification only with a documented exception',async()=>{
  await expect(as('eng','request',PA,'10',REASON,'--no-notify')).rejects.toThrow();
  const {grant}=await as('eng','request',PA,'10',REASON,'--no-notify','Active legal hold order ref LH-7');
  expect((await admin.query('SELECT notify_customer,notification_exception FROM break_glass_grants WHERE id=$1',[grant])).rows[0])
   .toEqual({notify_customer:false,notification_exception:'Active legal hold order ref LH-7'});
  expect(await listBreakGlassForCustomer()).toEqual([]);
 });
 it('keeps the audit trail append-only: no app or operator role can edit or delete it',async()=>{
  const g=await approved();
  for(const who of ['app','eng','owner']){
   const c=new Client({connectionString:urls[who]});await c.connect();
   try{
    await expect(c.query('DELETE FROM break_glass_access_log')).rejects.toThrow(/permission denied/);
    await expect(c.query("UPDATE break_glass_grants SET expires_at=now()+interval '9 hours'")).rejects.toThrow(/permission denied/);
    if(who==='app')await expect(c.query('SELECT break_glass_request($1,$2,10)',[PA,REASON])).rejects.toThrow(/permission denied/);
    else await expect(c.query('SELECT * FROM design_messages')).rejects.toThrow(/permission denied/);
   }finally{await c.end();}
  }
  expect(await log(g)).toHaveLength(2);
 });
 it('keeps break-glass logs after the project is purged, then purges them after 365 days',async()=>{
  const g=await approved();await as('eng','read',g);
  await admin.query("UPDATE projects SET status='archived',archived_at=now()-interval '91 days' WHERE id=$1",[PA]);
  await runRetentionPurge(urls.purge);
  expect((await admin.query('SELECT project_id FROM break_glass_grants WHERE id=$1',[g])).rows).toEqual([{project_id:null}]);
  expect(await log(g)).toHaveLength(3);
  await admin.query("BEGIN; SET LOCAL nasi.audit_maintenance='on'; UPDATE break_glass_access_log SET at=now()-interval '366 days'; COMMIT");await admin.query("UPDATE break_glass_grants SET requested_at=now()-interval '366 days'");
  expect((await runRetentionPurge(urls.purge)).break_glass_events).toBe(3);
  expect((await admin.query('SELECT count(*)::int AS n FROM break_glass_grants')).rows[0].n).toBe(0);
 });
});
