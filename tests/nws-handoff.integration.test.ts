import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
// BDD_F14_01 NWS/GAS mapping discipline (DIR §6.2, NWS_GAS_ADAPTER_CONTRACT.snl).
const identity=vi.hoisted(()=>({id:'00000000-0000-4000-8000-000000000001',clerk_user_id:'test_a'}));
vi.mock('@/lib/tenant/customer',()=>({requireCustomer:async()=>({...identity})}));
import {buildNwsHandoff} from '@/lib/nws/handoff';
import {closePgPools} from '@/lib/db/pg-sql';
const url=process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const CONTRACT='/home/dawud/systems/docs/gp1p/nws_gas_v1/NWS_GAS_ADAPTER_CONTRACT.snl';
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const P='00000000-0000-4000-8000-000000000011';
const requiredFields=()=>{const t=readFileSync(CONTRACT,'utf8');const m=t.split('REQUIRED_INPUT_FIELDS=\n')[1].split('\n\n')[0];return m.split('\n').map(s=>s.trim()).filter(Boolean);};
describe.skipIf(!url)('NWS handoff mapping (real PostgreSQL, app role)',()=>{
 let admin:Client;const oldUrl=process.env.DATABASE_URL;
 const approveDir=()=>admin.query(`INSERT INTO dir_drafts(project_id,customer_id,status,content,source_summary,source_approved_at,generated_by,approved_at,approved_by)
   VALUES($1,$2,'approved','{"v":1}','{}',now(),'test_a',now(),'test_a')`,[P,A]);
 const consent=async()=>{await admin.query(`INSERT INTO story_sets(project_id,customer_id,dir_sha256,stories,status,accepted_at,accepted_by)
   SELECT project_id,customer_id,encode(digest(content::text,'sha256'),'hex'),'[{"id":"ST01"}]','accepted',now(),approved_by FROM dir_drafts WHERE project_id=$1`,[P]);
  return (await admin.query(`INSERT INTO implementation_consents(project_id,customer_id,dir_sha256,approved_by)
   SELECT project_id,customer_id,encode(digest(content::text,'sha256'),'hex'),approved_by FROM dir_drafts WHERE project_id=$1 RETURNING id`,[P])).rows[0].id as string;};
 beforeAll(async()=>{
  const parsed=new URL(url!);if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/nasi_audit')throw new Error('ISOLATED_LOCAL_DB_REQUIRED');
  admin=new Client({connectionString:url});await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP ROLE IF EXISTS nws_app');
  for(const f of readdirSync(resolve('db/migrations')).filter(f=>f.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',f),'utf8'));
  await admin.query("CREATE ROLE nws_app LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE nasi_app_runtime");
  const u=new URL(url!);u.username='nws_app';u.password='local_audit_only';process.env.DATABASE_URL=u.toString();
 });
 beforeEach(async()=>{
  identity.id=A;identity.clerk_user_id='test_a';
  await admin.query('TRUNCATE story_sets,verification_packages,implementation_consents,dir_drafts,projects,customers CASCADE');
  await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'test_a'),($2,'test_b')",[A,B]);
  await admin.query("INSERT INTO projects(id,customer_id,name) VALUES($1,$2,'a')",[P,A]);
 });
 afterAll(async()=>{await closePgPools();await admin?.end();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;});

 it('payload carries exactly the adapter contract REQUIRED_INPUT_FIELDS, read from the contract on disk; never sent',async()=>{
  const h=await buildNwsHandoff(P);
  expect(Object.keys(h.payload).sort()).toEqual(requiredFields().sort());
  expect(h.payload).not.toHaveProperty('HITL_RESOLUTION_IF_VERIFIED');expect(h.payload).not.toHaveProperty('CURRENT_GP1P_RESULT_IF_VERIFIED');
  expect(h).toMatchObject({sent_to_nws:false,adapter_implementation_authorized:false});
  expect(readFileSync(CONTRACT,'utf8')).toContain('ADAPTER_IMPLEMENTATION_AUTHORIZED=NO');
 });
 it('no approved DIR: nothing is invented',async()=>{
  const {payload,not_asserted}=await buildNwsHandoff(P);
  expect(payload).toMatchObject({E_REFERENCE:null,E_TARGET_STATE:null,E_AUTHORIZED:false,E_AUTHORIZATION_PROOF_REFERENCE:null,CURRENT_AUTHORIZATION_BOUNDARY:null});
  expect(not_asserted.join(' ')).toContain('no customer-approved DIR');
 });
 it('approved DIR without implementation consent: E referenced but not authorized; boundary unchanged without HITL',async()=>{
  await approveDir();const {payload}=await buildNwsHandoff(P);
  expect(payload.E_REFERENCE).toMatch(/^nasi:project:.+:dir:[a-f0-9]{64}$/);
  expect(payload).toMatchObject({E_TARGET_STATE:null,E_AUTHORIZED:false,CURRENT_AUTHORIZATION_BOUNDARY:null});
 });
 it('with customer consent: E authorized with proof, boundary is the consent scope (nonproduction)',async()=>{
  await approveDir();const id=await consent();const {payload}=await buildNwsHandoff(P);
  expect(payload).toMatchObject({E_AUTHORIZED:true,E_AUTHORIZATION_PROOF_REFERENCE:`nasi:implementation_consent:${id}`,
   CURRENT_AUTHORIZATION_BOUNDARY:{scope:'nonproduction',consent_id:id,production:false}});
 });
 it('Scenario: No upgrade to verified without evidence - K is never asserted, even with passed SaaS verification packages',async()=>{
  await approveDir();await consent();
  await admin.query(`INSERT INTO verification_packages(project_id,customer_id,release_ref,checks,passed,evidence_sha256,submitted_by)
   VALUES($1,$2,'rel-2026.11.14-abc1234','[{"name":"unit_tests","status":"pass"}]',true,repeat('a',64),'fixture')`,[P,A]);
  const h=await buildNwsHandoff(P);
  expect(h.payload).toMatchObject({K_REFERENCE:null,K_VERIFIED_STATE:null,K_VERIFIED:false,K_VERIFICATION_PROOF_REFERENCE:null,VERIFIED_EVIDENCE_REFERENCES:[]});
  expect(h.saas_verification_packages_unverified_by_nws).toHaveLength(1);
  expect(h.not_asserted.join(' ')).toContain('no NWS verification evidence');
 });
 it('revoked consent or a changed DIR drops authorization (no stale widening)',async()=>{
  await approveDir();await consent();
  await admin.query("UPDATE dir_drafts SET content='{\"v\":2}'");
  expect((await buildNwsHandoff(P)).payload).toMatchObject({E_AUTHORIZED:false,CURRENT_AUTHORIZATION_BOUNDARY:null});
  await admin.query("UPDATE dir_drafts SET content='{\"v\":1}'");await admin.query('UPDATE implementation_consents SET revoked_at=now()');
  expect((await buildNwsHandoff(P)).payload).toMatchObject({E_AUTHORIZED:false,CURRENT_AUTHORIZATION_BOUNDARY:null});
 });
 it("another tenant cannot build a handoff from this project's state",async()=>{
  await approveDir();await consent();identity.id=B;identity.clerk_user_id='test_b';
  const h=await buildNwsHandoff(P);
  expect(h.payload).toMatchObject({E_REFERENCE:null,E_AUTHORIZED:false,CURRENT_AUTHORIZATION_BOUNDARY:null});
  expect(h.saas_verification_packages_unverified_by_nws).toEqual([]);
 });
});
