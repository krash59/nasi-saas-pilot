import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
// Found by the G3-10 real-browser check: a customer could confirm a summary field before the page's first summary
// load created the record (SUMMARY_NOT_FOUND), and two concurrent first loads could collide.
const identity=vi.hoisted(()=>({id:'00000000-0000-4000-8000-000000000001',clerk_user_id:'test_a'}));
vi.mock('@/lib/tenant/customer',()=>({requireCustomer:async()=>({...identity})}));
import {confirmSummaryField,getOrCreateSummary} from '@/lib/design/repository';
import {closePgPools} from '@/lib/db/pg-sql';
const url=process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002',P='00000000-0000-4000-8000-000000000011';
describe.skipIf(!url)('Design Summary first-use races (real PostgreSQL, app role)',()=>{
 let admin:Client;const oldUrl=process.env.DATABASE_URL;
 beforeAll(async()=>{
  const parsed=new URL(url!);if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/nasi_audit')throw new Error('ISOLATED_LOCAL_DB_REQUIRED');
  admin=new Client({connectionString:url});await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP ROLE IF EXISTS race_app');
  for(const f of readdirSync(resolve('db/migrations')).filter(f=>f.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',f),'utf8'));
  await admin.query("CREATE ROLE race_app LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE nasi_app_runtime");
  const u=new URL(url!);u.username='race_app';u.password='local_audit_only';process.env.DATABASE_URL=u.toString();
 });
 beforeEach(async()=>{
  identity.id=A;identity.clerk_user_id='test_a';
  await admin.query('TRUNCATE customers CASCADE');
  await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'test_a'),($2,'test_b')",[A,B]);
  await admin.query("INSERT INTO projects(id,customer_id,name) VALUES($1,$2,'a')",[P,A]);
 });
 afterAll(async()=>{await closePgPools();await admin?.end();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;});

 it('confirming a field before the summary was ever loaded creates it instead of failing',async()=>{
  const fields=await confirmSummaryField(P,'problem_statement','Clinics cannot take online bookings');
  expect(fields.problem_statement.customer_confirmed).toBe('Clinics cannot take online bookings');
  expect(Number((await admin.query('SELECT count(*) FROM design_summaries WHERE project_id=$1',[P])).rows[0].count)).toBe(1);
 });
 it('concurrent first loads create exactly one summary without errors',async()=>{
  const all=await Promise.all(Array.from({length:6},()=>getOrCreateSummary(P)));
  expect(all.every(s=>s.project_id===P)).toBe(true);
  expect(Number((await admin.query('SELECT count(*) FROM design_summaries WHERE project_id=$1',[P])).rows[0].count)).toBe(1);
 });
 it('another tenant still cannot create or confirm a summary on this project',async()=>{
  identity.id=B;identity.clerk_user_id='test_b';
  await expect(confirmSummaryField(P,'problem_statement','intrusion')).rejects.toThrow();
  expect(Number((await admin.query('SELECT count(*) FROM design_summaries')).rows[0].count)).toBe(0);
 });
});
