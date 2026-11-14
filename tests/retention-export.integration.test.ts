import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
// BDD_F11_01 export during active account and 30-day offboard window; BDD_F11_02 scheduled purge.
const identity=vi.hoisted(()=>({id:'00000000-0000-4000-8000-000000000001',clerk_user_id:'test_a'}));
vi.mock('@/lib/tenant/customer',()=>({requireCustomer:async()=>({...identity})}));
import {archiveProject,exportCustomerData,requestOffboarding} from '@/lib/account/export';
import {GET as exportGet} from '@/app/api/account/export/route';
import {closePgPools} from '@/lib/db/pg-sql';
// @ts-expect-error plain ESM script without types
import {runRetentionPurge} from '../scripts/retention-purge.mjs';
const url=process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const PA='00000000-0000-4000-8000-000000000011',PA2='00000000-0000-4000-8000-000000000013',PB='00000000-0000-4000-8000-000000000012';
const asB=()=>{identity.id=B;identity.clerk_user_id='test_b';};
describe.skipIf(!url)('Export window and retention purge (real PostgreSQL, least-privilege roles)',()=>{
 let admin:Client;let purgeUrl:string;let appUrl:string;const oldUrl=process.env.DATABASE_URL;
 const q=async(sql:string,p:unknown[]=[])=>(await admin.query(sql,p)).rows;
 const n=async(sql:string,p:unknown[]=[])=>Number((await admin.query(sql,p)).rows[0].n);
 beforeAll(async()=>{
  const parsed=new URL(url!);if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/nasi_audit')throw new Error('ISOLATED_LOCAL_DB_REQUIRED');
  admin=new Client({connectionString:url});await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP ROLE IF EXISTS nasi_ret_app; DROP ROLE IF EXISTS nasi_ret_purge');
  for(const f of readdirSync(resolve('db/migrations')).filter(f=>f.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',f),'utf8'));
  await admin.query("CREATE ROLE nasi_ret_app LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE nasi_app_runtime");
  await admin.query("CREATE ROLE nasi_ret_purge LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE nasi_retention_purge");
  const a=new URL(url!);a.username='nasi_ret_app';a.password='local_audit_only';appUrl=a.toString();process.env.DATABASE_URL=appUrl;
  const p=new URL(url!);p.username='nasi_ret_purge';p.password='local_audit_only';purgeUrl=p.toString();
 });
 beforeEach(async()=>{
  identity.id=A;identity.clerk_user_id='test_a';
  await admin.query('TRUNCATE retention_purge_runs,usage_meter_events,security_audit_events,implementation_consents,dir_drafts,design_summaries,design_messages,projects,customers CASCADE');
  await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'test_a'),($2,'test_b')",[A,B]);
  await admin.query("INSERT INTO projects(id,customer_id,name) VALUES($1,$2,'a'),($3,$2,'a2'),($4,$5,'b')",[PA,A,PA2,PB,B]);
  await admin.query("INSERT INTO design_messages(project_id,role,content,is_ai_draft) VALUES($1,'customer','A secret idea',false),($2,'customer','B secret idea',false)",[PA,PB]);
 });
 afterAll(async()=>{await closePgPools();await admin?.end();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;});

 describe('BDD_F11_01 export',()=>{
  it('exports all of the customer\'s own data and nothing of another tenant',async()=>{
   const b=await exportCustomerData();
   expect(b.format).toBe('nasi-customer-export-v1');
   expect(b.projects.map(p=>p.id as string).sort()).toEqual([PA,PA2]);
   expect(b.design_messages.map(m=>m.content)).toEqual(['A secret idea']);
   expect(JSON.stringify(b)).not.toContain('B secret idea');
   expect(await n("SELECT count(*) AS n FROM security_audit_events WHERE customer_id=$1 AND event_type='DATA_EXPORTED'",[A])).toBe(1);
  });
  it('serves the export as a no-store download over the API',async()=>{
   const r=await exportGet();expect(r.status).toBe(200);
   expect(r.headers.get('content-disposition')).toContain('attachment');expect(r.headers.get('cache-control')).toBe('no-store');
  });
  it('still exports during the 30-day offboarding window',async()=>{
   const o=await requestOffboarding();
   expect(new Date(o.export_until).getTime()-new Date(o.offboard_requested_at).getTime()).toBe(30*86400_000);
   await admin.query("UPDATE customers SET offboard_requested_at=now()-interval '29 days' WHERE id=$1",[A]);
   await expect(exportCustomerData()).resolves.toBeTruthy();
  });
  it('closes export after the window (410) and keeps the original request date',async()=>{
   await requestOffboarding();await admin.query("UPDATE customers SET offboard_requested_at=now()-interval '31 days' WHERE id=$1",[A]);
   await requestOffboarding();
   expect(await n("SELECT count(*) AS n FROM customers WHERE id=$1 AND offboard_requested_at < now()-interval '30 days'",[A])).toBe(1);
   await expect(exportCustomerData()).rejects.toThrow('EXPORT_WINDOW_CLOSED');
   expect((await exportGet()).status).toBe(410);
  });
  it('does not let one tenant offboard or archive another',async()=>{
   asB();await requestOffboarding();
   expect(await q('SELECT id FROM customers WHERE offboard_requested_at IS NOT NULL')).toEqual([{id:B}]);
   await expect(archiveProject(PA)).rejects.toThrow('NOT_FOUND');
  });
 });

 describe('BDD_F11_02 scheduled purge per approved retention periods',()=>{
  it('purges only data past its retention period, tenant by tenant',async()=>{
   await archiveProject(PA);
   await admin.query("UPDATE projects SET archived_at=now()-interval '91 days' WHERE id=$1",[PA]);
   await admin.query("INSERT INTO security_audit_events(customer_id,event_type,resource_type,resource_id,created_at) VALUES($1,'PROJECT_ACCESS_DENIED','project','x',now()-interval '366 days'),($1,'PROJECT_ACCESS_DENIED','project','y',now()-interval '364 days')",[B]);
   await admin.query("INSERT INTO usage_meter_events(customer_id,meter,quantity,source,occurred_at) VALUES($1,'design_tokens',5,'t',now()-interval '25 months'),($1,'design_tokens',7,'t',now()-interval '23 months')",[B]);
   const s=await runRetentionPurge(purgeUrl);
   expect(s).toMatchObject({customers:2,archived_projects:1,security_events:1,usage_events:1,accounts_erased:0});
   expect(await q('SELECT id FROM projects ORDER BY id')).toEqual([{id:PB},{id:PA2}]);
   expect(await n("SELECT count(*) AS n FROM design_messages WHERE project_id=$1",[PA])).toBe(0);
   expect(await n("SELECT count(*) AS n FROM security_audit_events WHERE customer_id=$1",[B])).toBe(1);
   expect(await n("SELECT count(*) AS n FROM usage_meter_events WHERE customer_id=$1",[B])).toBe(1);
   expect(await n('SELECT count(*) AS n FROM retention_purge_runs')).toBe(2);
  });
  it('keeps recently archived projects and an account still inside its export window',async()=>{
   await archiveProject(PA);await admin.query("UPDATE projects SET archived_at=now()-interval '89 days' WHERE id=$1",[PA]);
   await requestOffboarding();await admin.query("UPDATE customers SET offboard_requested_at=now()-interval '29 days' WHERE id=$1",[A]);
   expect(await runRetentionPurge(purgeUrl)).toMatchObject({archived_projects:0,accounts_erased:0});
   expect(await n('SELECT count(*) AS n FROM projects WHERE customer_id=$1',[A])).toBe(2);
  });
  it('erases an offboarded account once its 30-day export window has closed',async()=>{
   await requestOffboarding();await admin.query("UPDATE customers SET offboard_requested_at=now()-interval '31 days' WHERE id=$1",[A]);
   expect(await runRetentionPurge(purgeUrl)).toMatchObject({accounts_erased:1});
   expect(await n('SELECT count(*) AS n FROM customers WHERE id=$1',[A])).toBe(0);
   expect(await n('SELECT count(*) AS n FROM projects WHERE customer_id=$1',[A])).toBe(0);
   expect(await n("SELECT count(*) AS n FROM design_messages")).toBe(1);
   expect(await n('SELECT count(*) AS n FROM customers WHERE id=$1',[B])).toBe(1);
   expect(await q("SELECT customer_id FROM retention_purge_runs WHERE counts->>'account_erased'='true'")).toEqual([{customer_id:A}]);
  });
  it('is a no-op when nothing is due',async()=>{
   expect(await runRetentionPurge(purgeUrl)).toEqual({customers:0,archived_projects:0,security_events:0,usage_events:0,break_glass_events:0,accounts_erased:0});
  });
  it('confines the purge role to RLS and the app role away from purge powers',async()=>{
   const p=new Client({connectionString:purgeUrl});await p.connect();
   const app=new Client({connectionString:appUrl});await app.connect();
   try{
    expect((await p.query('SELECT count(*)::int AS n FROM projects')).rows[0].n).toBe(0);           // no tenant context: sees nothing
    expect((await p.query('DELETE FROM security_audit_events')).rowCount).toBe(0);
    await expect(p.query('SELECT * FROM design_messages')).rejects.toThrow(/permission denied/);     // cannot read content
    await expect(p.query("UPDATE customers SET offboard_requested_at=now()")).rejects.toThrow(/permission denied/);
    await expect(app.query('SELECT retention_due_customers()')).rejects.toThrow(/permission denied/);
    await expect(app.query('SELECT erase_customer_if_window_closed()')).rejects.toThrow(/permission denied/);
    await expect(app.query('SELECT * FROM retention_purge_runs')).rejects.toThrow(/permission denied/);
    await p.query('BEGIN');await p.query("SELECT set_config('app.current_customer_id',$1,true)",[A]);
    expect((await p.query('SELECT erase_customer_if_window_closed() AS e')).rows[0].e).toBe(false);   // window not closed
    await p.query('ROLLBACK');
   }finally{await p.end();await app.end();}
  });
 });
});
