import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {Client} from 'pg';
import {createHmac} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
const identity=vi.hoisted(()=>({id:'00000000-0000-4000-8000-000000000001'}));
vi.mock('@/lib/tenant/customer',()=>({requireCustomer:async()=>({...identity})}));
import {applyStripePilotEvent,readPilotEntitlement} from '@/lib/providers/stripe-pilot';
import {POST as webhookPost} from '@/app/api/providers/stripe/webhook/route';
import {GET as entitlementGet} from '@/app/api/billing/entitlement/route';
import {getSql,withCustomerContext} from '@/lib/db/client';
import {closePgPools} from '@/lib/db/pg-sql';
const url=process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
const secret='whsec_local_synthetic_billing_only';
const payload=(id:string,created:number,state='active',tenant=A)=>JSON.stringify({id,type:state==='canceled'?'customer.subscription.deleted':'customer.subscription.updated',created,livemode:false,data:{object:{id:'sub_fixture_a',object:'subscription',customer:'cus_fixture_a',livemode:false,status:state,metadata:{tenant_id:tenant}}}});
const sign=(raw:string,now=Math.floor(Date.now()/1000))=>`t=${now},v1=${createHmac('sha256',secret).update(`${now}.${raw}`).digest('hex')}`;
describe.skipIf(!url)('Real PostgreSQL pilot billing and entitlement HTTP integration',()=>{
 let admin:Client,appUrl:string;const oldUrl=process.env.DATABASE_URL;
 beforeAll(async()=>{
  const parsed=new URL(url!);if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/nasi_audit')throw new Error('ISOLATED_LOCAL_DB_REQUIRED');
  admin=new Client({connectionString:url});await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; DROP ROLE IF EXISTS nasi_billing_app');
  for(const n of readdirSync(resolve('db/migrations')).filter(n=>n.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',n),'utf8'));
  await admin.query("CREATE ROLE nasi_billing_app LOGIN PASSWORD 'local_billing_only' NOSUPERUSER NOBYPASSRLS");
  await admin.query('GRANT USAGE ON SCHEMA public TO nasi_billing_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO nasi_billing_app');
  parsed.username='nasi_billing_app';parsed.password='local_billing_only';appUrl=parsed.toString();process.env.DATABASE_URL=appUrl;
  vi.stubEnv('NASI_PROVIDER_MODE','synthetic-pilot');vi.stubEnv('STRIPE_WEBHOOK_SECRET',secret);
 });
 beforeEach(async()=>{
  identity.id=A;
  await admin.query('TRUNCATE customers CASCADE');await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'synthetic_a'),($2,'synthetic_b')",[A,B]);
  await admin.query("INSERT INTO pilot_billing_accounts(customer_id,stripe_customer_id,stripe_subscription_id) VALUES($1,'cus_fixture_a','sub_fixture_a'),($2,'cus_fixture_b','sub_fixture_b')",[A,B]);
 });
 afterAll(async()=>{await closePgPools();await admin?.end();vi.unstubAllEnvs();if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;});
 const apply=(raw:string)=>applyStripePilotEvent(raw,sign(raw),secret,getSql(appUrl));
 it('applies authentic test event through HTTP and reads tenant-scoped entitlement',async()=>{
  const raw=payload('evt_first',1000);const r=await webhookPost(new Request('http://localhost/api/providers/stripe/webhook',{method:'POST',headers:{'stripe-signature':sign(raw)},body:raw}));expect(r.status).toBe(200);
  const result=await (await entitlementGet()).json();expect(result.designExportEnabled).toBe(true);expect(result.nwsExecutionAuthorized).toBe(false);expect(result.productionReleaseAuthorized).toBe(false);
  identity.id=B;expect((await (await entitlementGet()).json()).designExportEnabled).toBe(false);
 });
 it('serializes concurrent replay to one event and one effect',async()=>{
  const raw=payload('evt_concurrent',1000);const results=await Promise.all(Array.from({length:12},()=>apply(raw)));expect(results.filter(r=>r.decision==='APPLIED')).toHaveLength(1);expect(results.filter(r=>r.decision==='DUPLICATE')).toHaveLength(11);
  expect((await admin.query('SELECT * FROM pilot_billing_events')).rows).toHaveLength(1);
 });
 it('revokes entitlement on subscription cancellation',async()=>{
  await apply(payload('evt_active',1000));await apply(payload('evt_cancel',1001,'canceled'));expect((await readPilotEntitlement(getSql(appUrl),A)).designExportEnabled).toBe(false);
 });
 it.each(['past_due','unpaid','paused','incomplete'])('denies entitlement in %s state',async state=>{await apply(payload('evt_state',1000,state));expect((await readPilotEntitlement(getSql(appUrl),A)).designExportEnabled).toBe(false);});
 it('rejects wrong-tenant binding without updating either tenant',async()=>{
  await expect(apply(payload('evt_wrong',1000,'active',B))).rejects.toThrow('SUBSCRIPTION_BINDING_MISMATCH');expect((await admin.query('SELECT * FROM pilot_billing_events')).rowCount).toBe(0);
 });
 it('rejects stale events without promoting state',async()=>{
  await apply(payload('evt_current',1001,'canceled'));
  await expect(apply(payload('evt_old',999))).rejects.toThrow('STALE_OR_AMBIGUOUS_EVENT');
  expect((await readPilotEntitlement(getSql(appUrl),A)).designExportEnabled).toBe(false);
 });
 it('holds active entitlement when same-second conflicting events require reconciliation',async()=>{
  await apply(payload('evt_active',1000));expect((await readPilotEntitlement(getSql(appUrl),A)).designExportEnabled).toBe(true);
  expect((await apply(payload('evt_ambiguous',1000,'canceled'))).decision).toBe('RECONCILIATION_REQUIRED');
  const held=await readPilotEntitlement(getSql(appUrl),A);expect(held.designExportEnabled).toBe(false);expect(held.reconciliationRequired).toBe(true);
  expect((await apply(payload('evt_ambiguous',1000,'canceled'))).decision).toBe('DUPLICATE');
 });
 it('preserves RLS at direct account and event query boundaries',async()=>{
  await apply(payload('evt_visible',1000));const rows=await withCustomerContext(getSql(appUrl),B,tx=>tx`SELECT customer_id FROM pilot_billing_accounts`);expect(rows.map(r=>r.customer_id)).toEqual([B]);
  const hidden=await withCustomerContext(getSql(appUrl),B,tx=>tx`SELECT event_id FROM pilot_billing_events`);expect(hidden).toHaveLength(0);
 });
 it('rejects changed body at HTTP without creating event state',async()=>{
  const raw=payload('evt_tamper',1000);const r=await webhookPost(new Request('http://localhost',{method:'POST',headers:{'stripe-signature':sign(raw)},body:raw+' '}));expect(r.status).toBe(400);expect((await admin.query('SELECT * FROM pilot_billing_events')).rowCount).toBe(0);
 });
});
