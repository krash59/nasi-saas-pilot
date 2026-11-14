import {describe,expect,it,vi} from 'vitest';
// S01_01 / S01_02 operator invite + magic link. Provider HTTP is mocked here (unit layer);
// the live Clerk + Resend + real-browser path is proven by audit/tools/app_http_e2e.py clerk_invite.
// @ts-expect-error plain ESM script without types
import {inviteCustomer} from '../scripts/invite-customer.mjs';
const base={email:'person@example.com',clerkSecret:'sk_test_x',resendKey:'re_x',appUrl:'https://app.example.com'};
const ok=(json:unknown,status=200)=>new Response(JSON.stringify(json),{status});
function provider(over:Record<string,Response>={}){
 const calls:{url:string;method:string;body:unknown}[]=[];
 const f=vi.fn(async(url:string,init:RequestInit)=>{
  const key=`${init.method} ${url.replace(/\?.*/,'')}`;calls.push({url,method:init.method!,body:init.body?JSON.parse(String(init.body)):undefined});
  if(over[key])return over[key].clone();
  if(key==='POST https://api.clerk.com/v1/allowlist_identifiers')return ok({id:'alid_1'});
  if(key==='GET https://api.clerk.com/v1/users')return ok([]);
  if(key==='POST https://api.clerk.com/v1/users')return ok({id:'user_1'});
  if(key==='POST https://api.clerk.com/v1/sign_in_tokens')return ok({id:'sit_1',token:'secret_ticket_value'});
  if(key==='POST https://api.resend.com/emails')return ok({id:'00000000-0000-4000-8000-0000000000aa'});
  return ok({},404);});
 return {f,calls};
}
describe('operator invite (S01_01) and magic link (S01_02)',()=>{
 it('allow-lists, provisions the user, mints a short-lived single-use token and emails the NASI sign-in link',async()=>{
  const {f,calls}=provider();const r=await inviteCustomer({...base,fetch:f});
  expect(r).toEqual({user_id:'user_1',allowlist:'added',magic_link_expires_minutes:15,email_id:'00000000-0000-4000-8000-0000000000aa'});
  expect(JSON.stringify(r)).not.toContain('secret_ticket_value');
  expect(calls.map(c=>c.method+' '+c.url.replace(/\?.*/,''))).toEqual(['POST https://api.clerk.com/v1/allowlist_identifiers','GET https://api.clerk.com/v1/users',
   'POST https://api.clerk.com/v1/users','POST https://api.clerk.com/v1/sign_in_tokens','POST https://api.resend.com/emails']);
  expect(calls[3].body).toEqual({user_id:'user_1',expires_in_seconds:900});
  const mail=calls[4].body as {to:string[];text:string};expect(mail.to).toEqual(['person@example.com']);
  expect(mail.text).toContain('https://app.example.com/sign-in?__clerk_ticket=secret_ticket_value');expect(mail.text).toContain('single use, expires in 15 minutes');
 });
 it('re-inviting an existing user reuses the account and still sends a fresh link',async()=>{
  const {f,calls}=provider({'POST https://api.clerk.com/v1/allowlist_identifiers':ok({},422),'GET https://api.clerk.com/v1/users':ok([{id:'user_9'}])});
  expect(await inviteCustomer({...base,fetch:f})).toMatchObject({user_id:'user_9',allowlist:'already'});
  expect(calls.some(c=>c.method==='POST'&&c.url.endsWith('/v1/users'))).toBe(false);
 });
 it('fails closed on bad input or provider errors, before anything is emailed',async()=>{
  for(const [over,code] of [[{email:'not-an-email'},'INVALID_EMAIL'],[{clerkSecret:'pk_test_x'},'CLERK_NOT_CONFIGURED'],[{ttlMinutes:61},'INVALID_TTL'],
    [{appUrl:'http://app.example.com'},'APP_URL_MUST_BE_HTTPS'],[{resendKey:''},'EMAIL_NOT_CONFIGURED']] as const){
   const {f}=provider();await expect(inviteCustomer({...base,...over,fetch:f})).rejects.toThrow(code);expect(f).not.toHaveBeenCalled();
  }
  for(const [key,code] of [['POST https://api.clerk.com/v1/allowlist_identifiers','ALLOWLIST_FAILED'],['POST https://api.clerk.com/v1/users','USER_PROVISION_FAILED'],
    ['POST https://api.clerk.com/v1/sign_in_tokens','SIGN_IN_TOKEN_FAILED'],['POST https://api.resend.com/emails','EMAIL_SEND_FAILED']]){
   const {f,calls}=provider({[key]:ok({},500)});await expect(inviteCustomer({...base,fetch:f})).rejects.toThrow(code);
   if(code!=='EMAIL_SEND_FAILED')expect(calls.some(c=>c.url.includes('resend'))).toBe(false);
  }
 });
 it('allows plain http only for a loopback app URL (local testing)',async()=>{
  const {f}=provider();await expect(inviteCustomer({...base,appUrl:'http://localhost:3000',fetch:f})).resolves.toBeTruthy();
 });
 it('retries brief network failures and a lost create response without duplicating anything',async()=>{
  const {f,calls}=provider();let n=0;
  const flaky=vi.fn(async(url:string,init:RequestInit)=>{
   if(url.endsWith('/v1/sign_in_tokens')&&n++===0)throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ETIMEDOUT'}});
   return f(url,init);});
  expect(await inviteCustomer({...base,fetch:flaky})).toMatchObject({user_id:'user_1'});
  expect(calls.filter(c=>c.url.endsWith('/v1/sign_in_tokens'))).toHaveLength(1);
  const lost=provider({'POST https://api.clerk.com/v1/users':ok({},422)});let looked=0;
  const after=vi.fn(async(url:string,init:RequestInit)=>url.includes('/v1/users?')&&looked++>0?ok([{id:'user_lost'}]):lost.f(url,init));
  expect(await inviteCustomer({...base,fetch:after})).toMatchObject({user_id:'user_lost'});
 });
 it('does not retry real errors, and gives up after three network failures',async()=>{
  const dead=vi.fn(async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ETIMEDOUT'}});});
  await expect(inviteCustomer({...base,fetch:dead})).rejects.toThrow('fetch failed');expect(dead).toHaveBeenCalledTimes(3);
  const {f}=provider({'POST https://api.clerk.com/v1/allowlist_identifiers':ok({},403)});
  await expect(inviteCustomer({...base,fetch:f})).rejects.toThrow('ALLOWLIST_FAILED');expect(f).toHaveBeenCalledTimes(1);
 });
});
