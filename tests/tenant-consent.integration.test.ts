import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
const identity=vi.hoisted(()=>({id:'00000000-0000-4000-8000-000000000001',clerk_user_id:'test_a'}));
vi.mock('@/lib/tenant/customer',()=>({requireCustomer:async()=>({...identity})}));
import {authorizeImplementation,getImplementationConsent} from '@/lib/design/implementation-consent';
import {getSql,withCustomerContext} from '@/lib/db/client';
import {closePgPools} from '@/lib/db/pg-sql';
const url=process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const P='00000000-0000-4000-8000-000000000011',Q='00000000-0000-4000-8000-000000000012';
const content={sections:[{content:'Customer reviewed nonproduction scope'}]};
describe.skipIf(!url)('Real isolated PostgreSQL tenant transactions and consent',()=>{
 let admin:Client;let appUrl:string;const oldUrl=process.env.DATABASE_URL;
 beforeAll(async()=>{
  const parsed=new URL(url!);if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/nasi_audit')throw new Error('ISOLATED_LOCAL_DB_REQUIRED');
  admin=new Client({connectionString:url});await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP ROLE IF EXISTS nasi_consent_app');
  for(const n of readdirSync(resolve('db/migrations')).filter(n=>n.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',n),'utf8'));
  await admin.query("CREATE ROLE nasi_consent_app LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS");
  await admin.query('GRANT USAGE ON SCHEMA public TO nasi_consent_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO nasi_consent_app; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO nasi_consent_app');
  parsed.username='nasi_consent_app';parsed.password='local_audit_only';appUrl=parsed.toString();process.env.DATABASE_URL=appUrl;
 });
 beforeEach(async()=>{
  identity.id=A;identity.clerk_user_id='test_a';
  await admin.query('TRUNCATE implementation_consents,dir_drafts,design_summaries,design_messages,projects,customers CASCADE');
  await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'test_a'),($2,'test_b')",[A,B]);
  await admin.query("INSERT INTO projects(id,customer_id,name) VALUES($1,$2,'a'),($3,$4,'b')",[P,A,Q,B]);
  await admin.query("INSERT INTO dir_drafts(project_id,customer_id,status,content,source_summary,source_approved_at,generated_by,approved_at,approved_by) VALUES($1,$2,'approved',$3,'{}',now(),'test_a',now(),'test_a')",[P,A,JSON.stringify(content)]);
  await admin.query(`INSERT INTO story_sets(project_id,customer_id,dir_sha256,stories,status,accepted_at,accepted_by)
   SELECT project_id,customer_id,encode(digest(content::text,'sha256'),'hex'),'[{"id":"ST01"}]','accepted',now(),approved_by FROM dir_drafts`); // BDD_F07_01 fixture: story set accepted (migration 015)
 });
 afterAll(async()=>{await closePgPools();await admin?.end();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;});
 it('isolates forty concurrent tenant transactions',async()=>{
  const sql=getSql(appUrl);await Promise.all(Array.from({length:40},async(_,i)=>{
   const id=i%2?A:B;const rows=await withCustomerContext(sql,id,async tx=>{await tx`SELECT pg_sleep(0.003)`;return tx`SELECT customer_id FROM projects`;});
   expect(rows).toHaveLength(1);expect(rows[0].customer_id).toBe(id);
  }));
 });
 it('rolls back a failed tenant transaction and clears its GUC',async()=>{
  const sql=getSql(appUrl);await expect(withCustomerContext(sql,A,async tx=>{await tx`INSERT INTO projects(customer_id,name) VALUES(${A},'rollback')`;throw new Error('rollback');})).rejects.toThrow('rollback');
  const rows=await withCustomerContext(sql,A,tx=>tx`SELECT name FROM projects`);expect(rows.map(r=>r.name)).toEqual(['a']);
  const raw=await sql`SELECT app_current_customer_id() AS customer`;expect(raw[0].customer).toBeNull();
 });
 it('persists and reads the exact customer/project/DIR consent',async()=>{
  const r=await authorizeImplementation(P,content);expect(r.nwsExecutionAuthorized).toBe(false);expect(r.productionReleaseAuthorized).toBe(false);
  expect(await getImplementationConsent(P,r.consent.id as string)).not.toBeNull();
 });
 it('denies another customer at SQL/RLS boundary',async()=>{
  identity.id=B;identity.clerk_user_id='test_b';await expect(authorizeImplementation(P,content)).rejects.toThrow('APPROVED_DIR_REVIEW_MISMATCH');
 });
 it('denies changed reviewed content',async()=>{await expect(authorizeImplementation(P,{changed:true})).rejects.toThrow('APPROVED_DIR_REVIEW_MISMATCH');});
 it('denies unapproved DIR',async()=>{
  await admin.query("UPDATE dir_drafts SET status='AI_DRAFT',approved_at=NULL,approved_by=NULL");await expect(authorizeImplementation(P,content)).rejects.toThrow('APPROVED_DIR_REVIEW_MISMATCH');
 });
 it('invalidates consent when the current DIR changes',async()=>{
  const r=await authorizeImplementation(P,content);await admin.query("UPDATE dir_drafts SET content='{}'");expect(await getImplementationConsent(P,r.consent.id as string)).toBeNull();
 });
 it('denies expired and revoked records',async()=>{
  const r=await authorizeImplementation(P,content);await admin.query("UPDATE implementation_consents SET granted_at=now()-interval '2 hours',expires_at=now()-interval '1 hour'");expect(await getImplementationConsent(P,r.consent.id as string)).toBeNull();
  const s=await authorizeImplementation(P,content);await admin.query('UPDATE implementation_consents SET revoked_at=now()');expect(await getImplementationConsent(P,s.consent.id as string)).toBeNull();
 });
 it('does not reveal another customer consent',async()=>{
  const r=await authorizeImplementation(P,content);identity.id=B;identity.clerk_user_id='test_b';expect(await getImplementationConsent(P,r.consent.id as string)).toBeNull();
 });
});
