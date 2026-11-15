import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {Client} from 'pg';
import {randomBytes} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
// S02_01 / BDD_F02_01 MFA on privileged accounts (DIR §4.1 "Operators: MFA + RBAC"; owner decision OPTION_A).
// TOTP per IETF RFC 6238; checked against the RFC Appendix B SHA1 test vectors.
// @ts-expect-error plain ESM script without types
import {totp,splitOtp} from '../scripts/operator-mfa.mjs';
// @ts-expect-error plain ESM script without types
import {breakGlass} from '../scripts/break-glass.mjs';
// @ts-expect-error plain ESM script without types
import {releaseAuthority} from '../scripts/release-authority.mjs';
const url=process.env.NASI_ISOLATED_TEST_DATABASE_URL;
const RFC_SEED=Buffer.from('12345678901234567890');
const RFC=[[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']] as const;
const A='00000000-0000-4000-8000-000000000001',P='00000000-0000-4000-8000-000000000011';
const REASON='Customer ticket 7: summary will not load';

describe('RFC 6238 TOTP implementation',()=>{
 it('JavaScript implementation reproduces RFC 6238 Appendix B (SHA1)',()=>{
  for(const [t,code] of RFC)expect(totp(RFC_SEED,{time:t,digits:8})).toBe(code);
 });
 it('splits --otp out of CLI arguments',()=>{
  expect(splitOtp(['approve','g','--otp','123456'])).toEqual({otp:'123456',rest:['approve','g']});
  expect(splitOtp(['approve','g'])).toEqual({otp:null,rest:['approve','g']});
 });
});

describe.skipIf(!url)('Operator MFA on privileged accounts (real PostgreSQL, separate operator logins)',()=>{
 let admin:Client;const urls:Record<string,string>={};
 const as=(who:string)=>{const c=new Client({connectionString:urls[who]});return c;};
 const verify=async(who:string,code:string)=>{const c=as(who);await c.connect();try{return (await c.query('SELECT operator_mfa_verify($1) AS j',[code])).rows[0].j;}finally{await c.end();}};
 const log=async(login:string)=>(await admin.query('SELECT outcome FROM operator_mfa_log WHERE login=$1 ORDER BY at, id',[login])).rows.map(r=>r.outcome);
 beforeAll(async()=>{
  const parsed=new URL(url!);if(parsed.hostname!=='127.0.0.1'||parsed.pathname!=='/nasi_audit')throw new Error('ISOLATED_LOCAL_DB_REQUIRED');
  admin=new Client({connectionString:url});await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for(const r of ['mfa_eng','mfa_owner','mfa_app','mfa_releaser','mfa_admin'])await admin.query(`DROP ROLE IF EXISTS ${r}`);
  for(const f of readdirSync(resolve('db/migrations')).filter(f=>f.endsWith('.sql')).sort())await admin.query(readFileSync(resolve('db/migrations',f),'utf8'));
  const mk=async(name:string,role:string)=>{await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD 'local_audit_only' NOSUPERUSER NOBYPASSRLS IN ROLE ${role}`);
   const u=new URL(url!);u.username=name;u.password='local_audit_only';urls[name.replace('mfa_','')]=u.toString();};
  await mk('mfa_eng','nasi_break_glass');await mk('mfa_owner','nasi_break_glass_approver');await mk('mfa_app','nasi_app_runtime');
  await mk('mfa_releaser','nasi_platform_release_approver');await mk('mfa_admin','nasi_operator_mfa_admin');
 });
 beforeEach(async()=>{
  await admin.query('TRUNCATE operator_mfa_enrollments,operator_mfa_sessions,operator_mfa_log,break_glass_access_log,break_glass_grants,platform_production_authorizations,projects,customers CASCADE');
  await admin.query("INSERT INTO customers(id,clerk_user_id) VALUES($1,'test_a')",[A]);
  await admin.query("INSERT INTO projects(id,customer_id,name) VALUES($1,$2,'a')",[P,A]);
 });
 afterAll(async()=>{await admin?.end();});

 it('database TOTP reproduces RFC 6238 Appendix B (SHA1)',async()=>{
  for(const [t,code] of RFC)expect((await admin.query('SELECT operator_totp($1,$2,8) AS c',[RFC_SEED,Math.floor(t/30)])).rows[0].c).toBe(code);
 });
 it('every privileged operator action is refused without a fresh MFA session, before any effect, and logged',async()=>{
  await expect(breakGlass(urls.eng,['request',P,'15',REASON])).rejects.toThrow('OPERATOR_MFA_REQUIRED');
  await expect(releaseAuthority(urls.releaser,['platform','approve',P,'rel-2026.11.15-abcdef1','Platform checks green, change window open'])).rejects.toThrow('OPERATOR_MFA_REQUIRED');
  expect(Number((await admin.query('SELECT count(*) FROM break_glass_grants')).rows[0].count)).toBe(0);
  expect(Number((await admin.query('SELECT count(*) FROM platform_production_authorizations')).rows[0].count)).toBe(0);
  expect(await log('mfa_eng')).toEqual(['MFA_REQUIRED_DENIED']);
 });
 it('a valid code from the operator\'s own authenticator opens a session for THAT login only',async()=>{
  const secret=randomBytes(20);await admin.query('SELECT operator_mfa_enroll($1,$2)',['mfa_eng',secret]);
  const {grant}=await breakGlass(urls.eng,['request',P,'15',REASON,'--otp',totp(secret)]);expect(grant).toBeTruthy();
  await expect(breakGlass(urls.owner,['approve',grant])).rejects.toThrow('OPERATOR_MFA_REQUIRED');   // the engineer's MFA does not cover the approver
  expect(await log('mfa_eng')).toEqual(['ENROLLED','VERIFIED']);
 });
 it('wrong, malformed and reused codes are rejected; a not-enrolled login is refused',async()=>{
  const secret=randomBytes(20);await admin.query('SELECT operator_mfa_enroll($1,$2)',['mfa_owner',secret]);
  const good=totp(secret);const wrong=String((Number(good)+1)%1000000).padStart(6,'0');
  expect(await verify('owner',wrong)).toEqual({denied:'MFA_CODE_INVALID'});
  expect(await verify('owner','12ab56')).toEqual({denied:'MFA_CODE_INVALID'});
  expect((await verify('owner',good)).mfa).toBe('VERIFIED');
  expect(await verify('owner',good)).toEqual({denied:'MFA_CODE_ALREADY_USED'});
  expect(await verify('eng',good)).toEqual({denied:'MFA_NOT_ENROLLED'});
 });
 it('locks the login after 5 failures in 15 minutes, even for a correct code',async()=>{
  const secret=randomBytes(20);await admin.query('SELECT operator_mfa_enroll($1,$2)',['mfa_owner',secret]);
  for(let i=0;i<5;i++)expect((await verify('owner','000000')).denied).toBeTruthy();
  expect(await verify('owner',totp(secret))).toEqual({denied:'MFA_LOCKED'});
 });
 it('operator tools do not re-send codes while a session is open (no self-inflicted lockout)',async()=>{
  const secret=randomBytes(20);await admin.query('SELECT operator_mfa_enroll($1,$2)',['mfa_eng',secret]);
  for(let i=0;i<7;i++)await breakGlass(urls.eng,['request',P,'15',REASON,'--otp',totp(secret)]);
  expect(await log('mfa_eng')).toEqual(['ENROLLED','VERIFIED']);
  expect(Number((await admin.query('SELECT count(*) FROM break_glass_grants')).rows[0].count)).toBe(7);
 });
 it('sessions expire after 10 minutes',async()=>{
  const secret=randomBytes(20);await admin.query('SELECT operator_mfa_enroll($1,$2)',['mfa_eng',secret]);
  expect((await verify('eng',totp(secret))).mfa).toBe('VERIFIED');
  await admin.query("UPDATE operator_mfa_sessions SET expires_at=now()-interval '1 second'");
  await expect(breakGlass(urls.eng,['request',P,'15',REASON])).rejects.toThrow('OPERATOR_MFA_REQUIRED');
 });
 it('secrets and sessions are unreadable; only owners/MFA admins can enrol; the app role cannot touch MFA',async()=>{
  for(const who of ['app','eng','owner','releaser']){
   const c=as(who);await c.connect();
   try{
    await expect(c.query('SELECT * FROM operator_mfa_enrollments')).rejects.toThrow(/permission denied/);
    await expect(c.query("INSERT INTO operator_mfa_sessions(login) VALUES(current_user)")).rejects.toThrow(/permission denied/);
    await expect(c.query('SELECT operator_totp($1,1)',[RFC_SEED])).rejects.toThrow(/permission denied/);
    await expect(c.query('SELECT operator_mfa_enroll($1,$2)',[who==='app'?'mfa_eng':'mfa_'+who,randomBytes(20)])).rejects.toThrow(/permission denied|NOT_MFA_ADMIN/);
   }finally{await c.end();}
  }
  const c=as('admin');await c.connect();
  try{await c.query('SELECT operator_mfa_enroll($1,$2)',['mfa_eng',randomBytes(20)]);}finally{await c.end();}
  expect(await log('mfa_eng')).toEqual(['ENROLLED']);
 });
});
