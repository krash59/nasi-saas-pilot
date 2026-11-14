import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
// BDD_F05_01: Customer A cannot read Customer B project; the denial is denied AND recorded.
const identity=vi.hoisted(()=>({id:'00000000-0000-4000-8000-000000000001',clerk_user_id:'test_a'}));
vi.mock('@/lib/tenant/customer',()=>({requireCustomer:async()=>({...identity})}));
import {getProjectForCustomer} from '@/lib/design/repository';
import {closePgPools} from '@/lib/db/pg-sql';
const url=process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const PA='00000000-0000-4000-8000-000000000011',PB='00000000-0000-4000-8000-000000000012';
describe.skipIf(!url)('BDD_F05_01 cross-tenant denial is recorded (real PostgreSQL, least-privilege runtime role)',()=>{
 let admin:Client;let app:Client;const oldUrl=process.env.DATABASE_URL;
 beforeAll(async()=>{
  const parsed=new URL(url!);if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/nasi_audit')throw new Error('ISOLATED_LOCAL_DB_REQUIRED');
  admin=new Client({connectionString:url});await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP ROLE IF EXISTS nasi_sec_audit_app');
  for(const n of readdirSync(resolve('db/migrations')).filter(n=>n.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',n),'utf8'));
  // Same grants production gets: membership of the runtime group role only (migration 007/008).
  await admin.query("CREATE ROLE nasi_sec_audit_app LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE nasi_app_runtime");
  parsed.username='nasi_sec_audit_app';parsed.password='local_audit_only';process.env.DATABASE_URL=parsed.toString();
  app=new Client({connectionString:parsed.toString()});await app.connect();
 });
 beforeEach(async()=>{
  identity.id=A;identity.clerk_user_id='test_a';
  await admin.query('TRUNCATE security_audit_events,projects,customers CASCADE');
  await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'test_a'),($2,'test_b')",[A,B]);
  await admin.query("INSERT INTO projects(id,customer_id,name) VALUES($1,$2,'a'),($3,$4,'b')",[PA,A,PB,B]);
 });
 afterAll(async()=>{await closePgPools();await app?.end();await admin?.end();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;});
 it('denies Customer A access to Project B and records a security audit event',async()=>{
  expect(await getProjectForCustomer(PB)).toBeNull();
  const {rows}=await admin.query('SELECT customer_id,event_type,resource_type,resource_id FROM security_audit_events');
  expect(rows).toEqual([{customer_id:A,event_type:'PROJECT_ACCESS_DENIED',resource_type:'project',resource_id:PB}]);
 });
 it('records nothing for an allowed read of own project',async()=>{
  expect((await getProjectForCustomer(PA))?.id).toBe(PA);
  expect((await admin.query('SELECT count(*)::int AS n FROM security_audit_events')).rows[0].n).toBe(0);
 });
 it('keeps the audit trail append-only and tenant-scoped for the runtime role',async()=>{
  await getProjectForCustomer(PB);
  identity.id=B;identity.clerk_user_id='test_b';await getProjectForCustomer(PA);
  await expect(app.query('DELETE FROM security_audit_events')).rejects.toThrow(/permission denied/);
  await expect(app.query("UPDATE security_audit_events SET event_type='PROJECT_ACCESS_DENIED'")).rejects.toThrow(/permission denied/);
  await app.query('BEGIN');await app.query("SELECT set_config('app.current_customer_id',$1,true)",[B]);
  const own=await app.query('SELECT customer_id FROM security_audit_events');await app.query('COMMIT');
  expect(own.rows).toEqual([{customer_id:B}]);
 });
});
