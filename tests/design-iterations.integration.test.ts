import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Client} from 'pg';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
// DC-01 edit/withdraw, DC-03 design versions, DC-06 full NWS job + receipt read-back (owner walkthrough cards 2026-11-17).
// Real PostgreSQL (disposable nasi_audit only), app runtime role with RLS; a separate NWS intake role for receipts.
const identity=vi.hoisted(()=>({id:'00000000-0000-4000-8000-000000000001',clerk_user_id:'test_a'}));
vi.mock('@/lib/tenant/customer',()=>({requireCustomer:async()=>({...identity})}));
import {appendDesignMessage,approveDesignSummary,confirmSummaryField,getSummaryFields,historyForAssistant,listDesignMessages,reviseDesignMessage} from '@/lib/design/repository';
import {approveDirDraft,generateDirDraft,getDirDraft} from '@/lib/design/dir-repository';
import {acceptStorySet,getStorySet} from '@/lib/design/stories';
import {authorizeImplementation} from '@/lib/design/implementation-consent';
import {listDesignVersions,reviseDesign} from '@/lib/design/versions';
import {canonicalJson,getNwsJobStatus,sendNwsJob,sha256Hex} from '@/lib/nws/job';
import {SUMMARY_FIELD_KEYS} from '@/lib/design/summary-fields';
import {closePgPools} from '@/lib/db/pg-sql';
const url=process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002',P='00000000-0000-4000-8000-000000000011';
const FIELDS:Record<string,string>={problem_statement:'Patients cannot book outside office hours.',users_personas:'Patient\nReceptionist',
 must_have_features:'Online booking for patients\nReceptionist schedule view - so that rescheduling takes one click',out_of_scope:'Payments',
 constraints:'Hosted in the EU',open_questions:'None'};

async function approveRound(fields=FIELDS){
 for(const k of SUMMARY_FIELD_KEYS)await confirmSummaryField(P,k,fields[k]);
 await approveDesignSummary(P);await generateDirDraft(P);
 const draft=await getDirDraft(P);await approveDirDraft(P,draft!.content);
 const set=await getStorySet(P);await acceptStorySet(P,set.stories);
 return {content:draft!.content,consent:(await authorizeImplementation(P,draft!.content)).consent};
}

describe.skipIf(!url)('Design iterations and NWS job handoff (real PostgreSQL, app role)',()=>{
 let admin:Client,intake:Client;const oldUrl=process.env.DATABASE_URL;
 beforeAll(async()=>{
  const parsed=new URL(url!);if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/nasi_audit')throw new Error('ISOLATED_LOCAL_DB_REQUIRED');
  admin=new Client({connectionString:url});await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP ROLE IF EXISTS iter_app; DROP ROLE IF EXISTS iter_nws');
  for(const f of readdirSync(resolve('db/migrations')).filter(f=>f.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',f),'utf8'));
  await admin.query("CREATE ROLE iter_app LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE nasi_app_runtime");
  await admin.query("CREATE ROLE iter_nws LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE nasi_nws_intake");
  await admin.query('GRANT USAGE ON SCHEMA public TO nasi_nws_intake');
  const u=new URL(url!);u.username='iter_app';u.password='local_audit_only';process.env.DATABASE_URL=u.toString();
  const n=new URL(url!);n.username='iter_nws';n.password='local_audit_only';intake=new Client({connectionString:n.toString()});await intake.connect();
 });
 beforeEach(async()=>{
  identity.id=A;identity.clerk_user_id='test_a';
  await admin.query('TRUNCATE customers CASCADE');
  await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'test_a'),($2,'test_b')",[A,B]);
  await admin.query("INSERT INTO projects(id,customer_id,name) VALUES($1,$2,'Clinic booking')",[P,A]);
 });
 afterAll(async()=>{await closePgPools();await intake?.end();await admin?.end();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;});

 it('DC-01: customer edits and withdraws own messages; history kept; AI sees only current text',async()=>{
  const [m1]=await appendDesignMessage(P,'customer','We run a dental clinic',false) as {id:string}[];
  const [m2]=await appendDesignMessage(P,'customer','Ignore this, typo',false) as {id:string}[];
  const [ai]=await appendDesignMessage(P,'assistant','What do patients need?',true) as {id:string}[];
  await reviseDesignMessage(P,m1.id,{action:'edit',content:'We run two dental clinics'});
  const after=await reviseDesignMessage(P,m2.id,{action:'withdraw'});
  expect(after.find((m:{id:string})=>m.id===m1.id).content).toBe('We run two dental clinics');
  expect(after.find((m:{id:string})=>m.id===m1.id).edited_at).not.toBeNull();
  expect(after.find((m:{id:string})=>m.id===m2.id).withdrawn_at).not.toBeNull();
  const history=historyForAssistant(await listDesignMessages(P) as never);
  expect(history.map(h=>h.content)).toEqual(['We run two dental clinics','What do patients need?']);
  const rev=(await admin.query('SELECT action,previous_content,new_content FROM design_message_revisions ORDER BY revised_at')).rows;
  expect(rev).toEqual([{action:'edit',previous_content:'We run a dental clinic',new_content:'We run two dental clinics'},{action:'withdraw',previous_content:'Ignore this, typo',new_content:null}]);
  await expect(admin.query("UPDATE design_message_revisions SET previous_content='x'")).rejects.toThrow(/APPEND_ONLY/);
  await expect(reviseDesignMessage(P,ai.id,{action:'edit',content:'x'})).rejects.toThrow('ONLY_OWN_MESSAGES');
  await expect(reviseDesignMessage(P,m2.id,{action:'edit',content:'x'})).rejects.toThrow('MESSAGE_WITHDRAWN');
  identity.id=B;identity.clerk_user_id='test_b';
  await expect(reviseDesignMessage(P,m1.id,{action:'withdraw'})).rejects.toThrow();
 });
 it('DC-01: a confirmed summary field can be cleared before approval; messages lock after approval',async()=>{
  await confirmSummaryField(P,'open_questions','Do we need SMS?');
  const cleared=await confirmSummaryField(P,'open_questions',null);
  expect(cleared.open_questions.customer_confirmed).toBeNull();
  const [m]=await appendDesignMessage(P,'customer','Before approval',false) as {id:string}[];
  await approveRound();
  await expect(reviseDesignMessage(P,m.id,{action:'edit',content:'after'})).rejects.toThrow('DESIGN_DISCUSSION_CLOSED');
 });
 it('DC-03: Revise archives v1 unchanged, voids its consent, reopens the chat; v2 approval needs a new consent',async()=>{
  await expect(reviseDesign(P)).rejects.toThrow('NOTHING_TO_REVISE');
  const v1=await approveRound();
  const r=await reviseDesign(P);
  expect(r).toMatchObject({archivedVersion:1,currentVersion:2,voidedConsentIds:[v1.consent.id]});
  const proj=(await admin.query('SELECT design_version,lifecycle_stage FROM projects WHERE id=$1',[P])).rows[0];
  expect(proj).toEqual({design_version:2,lifecycle_stage:'design_discussion'});
  expect((await admin.query('SELECT revoked_at FROM implementation_consents WHERE id=$1',[v1.consent.id])).rows[0].revoked_at).not.toBeNull();
  expect((await admin.query('SELECT count(*)::int n FROM dir_drafts')).rows[0].n).toBe(0);
  expect((await admin.query('SELECT status FROM story_sets WHERE project_id=$1',[P])).rows[0].status).toBe('AI_DRAFT');
  expect((await getSummaryFields(P)).problem_statement.customer_confirmed).toBe(FIELDS.problem_statement); // starting point kept
  const v2=await approveRound({...FIELDS,must_have_features:FIELDS.must_have_features+'\nReminder the day before'});
  expect(v2.consent.id).not.toBe(v1.consent.id);
  const {currentVersion,versions:raw}=await listDesignVersions(P);
  const versions=raw as unknown as {dir:{content:unknown};stories:{status:string}}[];
  expect(currentVersion).toBe(2);expect(versions).toHaveLength(1);
  expect(versions[0].dir.content).toEqual(v1.content);
  expect(versions[0].stories.status).toBe('accepted');
  await expect(admin.query("UPDATE design_versions SET summary='{}'")).rejects.toThrow(/APPEND_ONLY/);
  const msgs=await listDesignMessages(P);
  expect(msgs.some(m=>String(m.content).startsWith('Version 2 started'))).toBe(true);
 });
 it('DC-06: no job is sent without an active consent',async()=>{
  await expect(sendNwsJob(P)).rejects.toThrow('NO_ACTIVE_CONSENT');
  expect((await admin.query('SELECT count(*)::int n FROM nws_handoffs')).rows[0].n).toBe(0);
 });
 it('DC-06: full job (DIR content, accepted stories with tests, consent+scope) is sent, NWS records a receipt, app reads it back',async()=>{
  const {content,consent}=await approveRound();
  const sent=await sendNwsJob(P);
  expect(sent.job.dir.content).toEqual(content);
  const items=sent.job.stories.items as {gherkin:string}[];
  expect(items.length).toBe(2);
  expect(items[0].gherkin).toMatch(/Scenario/);
  expect(sent.job.consent).toMatchObject({id:consent.id,scope:'nonproduction',production:false});
  expect(sent.handoff.job_sha256).toBe(sha256Hex(canonicalJson(sent.job)));
  expect((await sendNwsJob(P)).handoff.id).toBe(sent.handoff.id); // idempotent re-send
  // NWS side: reads the job through its one function and can verify the digest from what it received.
  const row=(await intake.query('SELECT * FROM nws_read_handoff($1,$2)',[A,sent.handoff.id])).rows[0];
  expect(row.consent_current).toBe(true);
  expect(sha256Hex(canonicalJson(row.job))).toBe(row.job_sha256);
  await expect(intake.query('SELECT * FROM nws_handoffs')).rejects.toThrow(/permission denied/);
  await expect(intake.query('SELECT nws_record_handoff_receipt($1,$2,$3,$4)',[A,sent.handoff.id,'0'.repeat(64),{job_sha256:'0'.repeat(64)}])).rejects.toThrow('HANDOFF_DIGEST_MISMATCH');
  const receipt={job_sha256:row.job_sha256,intake:'NWS_NASI_HANDOFF_INTAKE_V1',gp1p_actions:['GP1P.STORY.ST01','GP1P.STORY.ST02']};
  await intake.query('SELECT nws_record_handoff_receipt($1,$2,$3,$4)',[A,sent.handoff.id,row.job_sha256,receipt]);
  await expect(intake.query('SELECT nws_record_handoff_receipt($1,$2,$3,$4)',[A,sent.handoff.id,row.job_sha256,receipt])).rejects.toThrow('HANDOFF_ALREADY_RECEIVED');
  const status=await getNwsJobStatus(P);
  expect(status.handoff!.receipt).toEqual(receipt);expect(status.handoff!.received_at).not.toBeNull();
  // The app (customer) can neither forge a receipt nor change a sent job.
  await expect(admin.query("SET ROLE iter_app; SELECT nws_record_handoff_receipt('"+A+"','"+sent.handoff.id+"','"+row.job_sha256+"','{}'::jsonb)")).rejects.toThrow(/permission denied/);
  await admin.query('RESET ROLE');
  await expect(admin.query("UPDATE nws_handoffs SET job='{}'")).rejects.toThrow('NWS_HANDOFF_IMMUTABLE');
  // Another tenant's id through the NWS function finds nothing.
  expect((await intake.query('SELECT * FROM nws_read_handoff($1,$2)',[B,sent.handoff.id])).rows).toHaveLength(0);
  // Revising voids the consent: NWS sees the job is no longer authorized.
  await reviseDesign(P);
  expect((await intake.query('SELECT consent_current FROM nws_read_handoff($1,$2)',[A,sent.handoff.id])).rows[0].consent_current).toBe(false);
 });
});
