import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {Client} from 'pg';
import {createHmac,randomBytes} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {getSql,withCustomerContext} from '@/lib/db/client';
import {closePgPools} from '@/lib/db/pg-sql';
import {applyStripePilotEvent,readPilotEntitlement} from '@/lib/providers/stripe-pilot';
const credentialFile=process.env.NASI_NEW_CLAIMABLE_NEON_CREDENTIAL_FILE;
const identityFile=process.env.NASI_NEW_CLAIMABLE_NEON_IDENTITY_FILE;
const A='00000000-0000-4000-8000-000000000001',B='00000000-0000-4000-8000-000000000002';
describe.skipIf(!credentialFile||!identityFile)('New isolated claimable Neon provider acceptance',()=>{
 let admin:Client;let appUrl:string;let connected=false;let roleCreated=false;let fixturesCreated=false;
 const role='nasi_pilot_'+randomBytes(5).toString('hex');
 beforeAll(async()=>{
  const identity=JSON.parse(readFileSync(identityFile!,'utf8'));const credentials=JSON.parse(readFileSync(credentialFile!,'utf8'));
  if(!identity.project?.id || Date.parse(identity.project.expires_at)<=Date.now() || !identity.capabilities?.some((c:{capability:string,granted:boolean})=>c.capability==='postgres'&&c.granted))throw new Error('NEW_CLAIMABLE_PROJECT_PROOF_REQUIRED');
  const u=new URL(credentials.database_url);if(!u.hostname.endsWith('.neon.tech') || u.protocol!=='postgresql:')throw new Error('NEW_NEON_PROJECT_REQUIRED');
  admin=new Client({connectionString:u.toString(),connectionTimeoutMillis:15000,statement_timeout:15000});await admin.connect();connected=true;
  const initial=await admin.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
  if(initial.rows[0].n!==0){
   if(process.env.NASI_REUSE_OWNED_CLAIMABLE_FIXTURE!=='1')throw new Error('NEW_CLAIMABLE_DATABASE_NOT_EMPTY; NO_MUTATIONS_PERMITTED');
   const remaining=await admin.query('SELECT count(*)::int AS n FROM customers');
   if(remaining.rows[0].n!==0)throw new Error('PRIOR_SYNTHETIC_FIXTURE_NOT_EMPTY');
   // Only this newly registered project is eligible for a cleanup retry.
   const prior=await admin.query("SELECT rolname FROM pg_roles WHERE rolname ~ '^nasi_pilot_[0-9a-f]{10}$'");
   for(const row of prior.rows){
    await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${row.rolname}`);
    await admin.query(`REVOKE ALL ON SCHEMA public FROM ${row.rolname}`);
    await admin.query(`ALTER ROLE ${row.rolname} NOLOGIN`);
    await admin.query(`DROP ROLE ${row.rolname}`);
   }
  }else{
   for(const name of readdirSync(resolve('db/migrations')).filter(n=>n.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',name),'utf8'));
  }
  const password=randomBytes(24).toString('hex');
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);roleCreated=true;
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'synthetic_neon_a'),($2,'synthetic_neon_b')",[A,B]);fixturesCreated=true;
  await admin.query("INSERT INTO projects(customer_id,name) VALUES($1,'synthetic-neon-a'),($2,'synthetic-neon-b')",[A,B]);
  await admin.query("INSERT INTO pilot_billing_accounts(customer_id,stripe_customer_id,stripe_subscription_id) VALUES($1,'cus_neon_fixture_a','sub_neon_fixture_a'),($2,'cus_neon_fixture_b','sub_neon_fixture_b')",[A,B]);
  u.username=role;u.password=password;appUrl=u.toString();
 },60000);
 afterAll(async()=>{
  await closePgPools();
  if(connected){
   try {if(fixturesCreated)await admin.query('DELETE FROM customers WHERE id=ANY($1::uuid[])',[ [A,B] ]);
    if(roleCreated){
     await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
     await admin.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
     await admin.query(`ALTER ROLE ${role} NOLOGIN`);
     await admin.query(`DROP ROLE ${role}`);
    }
   } finally {await admin.end();}
  }
 },30000);
 it('uses a non-bypass tenant role on the real hosted service',async()=>{
  const roleRows=await getSql(appUrl)`SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname=current_user`;expect(roleRows[0]).toMatchObject({rolbypassrls:false,rolsuper:false});
 });
 it('isolates parallel tenant transactions through the actual application adapter',async()=>{
  await Promise.all(Array.from({length:16},async(_,i)=>{
   const tenant=i%2?A:B;const rows=await withCustomerContext(getSql(appUrl),tenant,tx=>tx`SELECT customer_id FROM projects`);expect(rows.map(r=>r.customer_id)).toEqual([tenant]);
  }));
 },30000);
 it('applies a synthetic signed billing event and persists the entitlement only for its bound tenant',async()=>{
  const now=Math.floor(Date.now()/1000),secret='whsec_hosted_synthetic_fixture';
  const raw=JSON.stringify({id:'evt_hosted_fixture',type:'customer.subscription.updated',created:now,livemode:false,data:{object:{id:'sub_neon_fixture_a',object:'subscription',customer:'cus_neon_fixture_a',livemode:false,status:'active',metadata:{tenant_id:A}}}});
  const sig=`t=${now},v1=${createHmac('sha256',secret).update(`${now}.${raw}`).digest('hex')}`;
  expect((await applyStripePilotEvent(raw,sig,secret,getSql(appUrl))).decision).toBe('APPLIED');
  expect((await readPilotEntitlement(getSql(appUrl),A)).designExportEnabled).toBe(true);
  expect((await readPilotEntitlement(getSql(appUrl),B)).designExportEnabled).toBe(false);
  expect((await applyStripePilotEvent(raw,sig,secret,getSql(appUrl))).decision).toBe('DUPLICATE');
 },30000);
});
