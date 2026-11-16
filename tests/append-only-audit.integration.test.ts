import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {Client} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
// FA-07 (NIST SP 800-53 AU-9, NWS policy I4): append-only audit tables refuse UPDATE/DELETE for every role,
// including the table owner/superuser (INCIDENT-1), except the retention purge, parent-row cascades and explicit
// named maintenance. Runs only on the disposable local nasi_audit database.
const url=process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const A='00000000-0000-4000-8000-0000000000a1',PA='00000000-0000-4000-8000-0000000000b1';
const TABLES=['security_audit_events','usage_meter_events','break_glass_access_log','operator_mfa_log','retention_purge_runs',
 'customer_release_authorizations','platform_production_authorizations','production_deploy_decisions'];
describe.skipIf(!url)('FA-07 append-only audit tables (real PostgreSQL)',()=>{
 let admin:Client;let purge:Client;let app:Client;
 beforeAll(async()=>{
  const parsed=new URL(url!);if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/nasi_audit')throw new Error('ISOLATED_LOCAL_DB_REQUIRED');
  admin=new Client({connectionString:url});await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP ROLE IF EXISTS ao_purge; DROP ROLE IF EXISTS ao_app');
  for(const n of readdirSync(resolve('db/migrations')).filter(n=>n.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',n),'utf8'));
  // The runner re-applies every file: applying 017 a second time must be harmless.
  await admin.query(readFileSync(resolve('db/migrations','017_append_only_audit.sql'),'utf8'));
  await admin.query("CREATE ROLE ao_purge LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE nasi_retention_purge");
  await admin.query("CREATE ROLE ao_app LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE nasi_app_runtime");
  const p=new URL(url!);p.username='ao_purge';p.password='local_audit_only';purge=new Client({connectionString:p.toString()});await purge.connect();
  const q=new URL(url!);q.username='ao_app';q.password='local_audit_only';app=new Client({connectionString:q.toString()});await app.connect();
 });
 beforeEach(async()=>{
  await admin.query('TRUNCATE operator_mfa_log,usage_meter_events,security_audit_events,projects,customers CASCADE');
  await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'ao_a')",[A]);
  await admin.query("INSERT INTO projects(id,customer_id,name) VALUES($1,$2,'a')",[PA,A]);
  await admin.query("INSERT INTO security_audit_events(customer_id,event_type,resource_type,resource_id) VALUES($1,'PROJECT_ACCESS_DENIED','project','x')",[A]);
  await admin.query("INSERT INTO usage_meter_events(customer_id,project_id,meter,quantity,source) VALUES($1,$2,'agent_minutes',1,'t')",[A,PA]);
  await admin.query("INSERT INTO operator_mfa_log(login,outcome) VALUES('op','REJECTED'),('op','LOCKED')");
 });
 afterAll(async()=>{await purge?.end();await app?.end();await admin?.end();});
 const count=async(t:string)=>(await admin.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;

 it('every append-only table carries the guard trigger',async()=>{
  const {rows}=await admin.query("SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname=c.relname||'_append_only' AND NOT t.tgisinternal");
  expect(rows.map(r=>r.relname).sort()).toEqual([...TABLES].sort());
 });
 it('the owner/superuser cannot delete or update audit rows (INCIDENT-1)',async()=>{
  await expect(admin.query("DELETE FROM operator_mfa_log WHERE outcome IN ('REJECTED','LOCKED')")).rejects.toThrow(/APPEND_ONLY_AUDIT_TABLE/);
  await expect(admin.query("UPDATE operator_mfa_log SET outcome='VERIFIED'")).rejects.toThrow(/APPEND_ONLY_AUDIT_TABLE/);
  await expect(admin.query('DELETE FROM security_audit_events')).rejects.toThrow(/APPEND_ONLY_AUDIT_TABLE/);
  await expect(admin.query('UPDATE usage_meter_events SET quantity=99')).rejects.toThrow(/APPEND_ONLY_AUDIT_TABLE/);
  expect(await count('operator_mfa_log')).toBe(2);expect(await count('security_audit_events')).toBe(1);
 });
 it('the app runtime role still cannot change audit rows',async()=>{
  await expect(app.query('DELETE FROM usage_meter_events')).rejects.toThrow(/permission denied/);
  await expect(app.query("UPDATE security_audit_events SET resource_id='y'")).rejects.toThrow(/permission denied/);
 });
 it('a failed step inside a transaction leaves audit rows intact (no partial follow-up)',async()=>{
  await admin.query('BEGIN');
  await expect(admin.query("DELETE FROM operator_mfa_log WHERE outcome='LOCKED'")).rejects.toThrow(/APPEND_ONLY_AUDIT_TABLE/);
  await admin.query('ROLLBACK');
  expect(await count('operator_mfa_log')).toBe(2);
 });
 it('the retention purge role may delete within its policy',async()=>{
  await purge.query('BEGIN');await purge.query("SELECT set_config('app.current_customer_id',$1,true)",[A]);
  const r=await purge.query('DELETE FROM security_audit_events');await purge.query('COMMIT');
  expect(r.rowCount).toBe(1);expect(await count('security_audit_events')).toBe(0);
 });
 it('erasing a customer still cascades into its audit rows',async()=>{
  await admin.query('DELETE FROM customers WHERE id=$1',[A]);
  expect(await count('security_audit_events')).toBe(0);expect(await count('usage_meter_events')).toBe(0);
 });
 it('named maintenance in one transaction is the only other way to change a row',async()=>{
  await admin.query("BEGIN; SET LOCAL nasi.audit_maintenance='on'; UPDATE operator_mfa_log SET at=now()-interval '1 day'; COMMIT");
  await expect(admin.query("UPDATE operator_mfa_log SET at=now()")).rejects.toThrow(/APPEND_ONLY_AUDIT_TABLE/);   // flag ended with the transaction
 });
});
