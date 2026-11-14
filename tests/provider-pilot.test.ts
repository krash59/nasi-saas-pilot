import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { createHmac } from 'node:crypto';
const mocks=vi.hoisted(()=>({customer:vi.fn()}));
vi.mock('@/lib/tenant/customer',()=>({requireCustomer:mocks.customer}));
import {sendPilotTestEmail} from '@/lib/providers/resend-pilot';
import {applyStripePilotEvent} from '@/lib/providers/stripe-pilot';
import {POST as mailPost} from '@/app/api/providers/resend/test/route';
import {POST as webhookPost} from '@/app/api/providers/stripe/webhook/route';
import {GET as entitlementGet} from '@/app/api/billing/entitlement/route';
import type {SqlClient} from '@/lib/db/client';
const A='00000000-0000-4000-8000-000000000001';
const config={NASI_PROVIDER_MODE:'synthetic-pilot',NASI_PILOT_CUSTOMER_IDS:A,RESEND_API_KEY:'re_synthetic_fixture_only'};
const event={id:'evt_fixture',type:'customer.subscription.updated',created:1000,livemode:false,data:{object:{id:'sub_fixture',object:'subscription',customer:'cus_fixture',livemode:false,status:'active',metadata:{tenant_id:A}}}};
const secret='whsec_synthetic_fixture_only';
const signed=(raw:string,t=1000)=>`t=${t},v1=${createHmac('sha256',secret).update(`${t}.${raw}`).digest('hex')}`;
describe('Provider pilot containment and HTTP boundaries',()=>{
 beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('NASI_PROVIDER_MODE','synthetic-pilot');vi.stubEnv('NASI_PILOT_CUSTOMER_IDS',A);vi.stubEnv('RESEND_API_KEY',config.RESEND_API_KEY);mocks.customer.mockResolvedValue({id:A});});
 afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
 it.each(['delivered','bounced','complained','suppressed'] as const)('dispatches only fixed %s test content with bearer and idempotency',async scenario=>{
  const transport=vi.fn().mockResolvedValue(Response.json({id:A}));
  const result=await sendPilotTestEmail(A,scenario,config,transport);
  expect(result.deliveryConfirmed).toBe(false);
  const [url,init]=transport.mock.calls[0];expect(url).toBe('https://api.resend.com/emails');expect(init.redirect).toBe('error');
  expect(init.headers.Authorization).toBe(`Bearer ${config.RESEND_API_KEY}`);expect(init.headers['Idempotency-Key']).toMatch(/^nasi-pilot-[0-9a-f]{64}$/);
  expect(JSON.parse(init.body).to).toEqual([`${scenario}@resend.dev`]);expect(init.body).not.toContain(A);
 });
 it.each([{...config,RESEND_API_KEY:undefined},{...config,NASI_PROVIDER_MODE:'production'},{...config,NASI_PILOT_CUSTOMER_IDS:''}])('denies missing key, wrong mode or unlisted caller before transport',async bad=>{
  const transport=vi.fn();await expect(sendPilotTestEmail(A,'delivered',bad,transport)).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
 });
 it('sanitizes provider response and network errors',async()=>{
  for(const transport of [vi.fn().mockRejectedValue(new Error('private_detail')),vi.fn().mockResolvedValue(new Response('private_detail',{status:401})),vi.fn().mockResolvedValue(Response.json({token:'private_detail'}))])await expect(sendPilotTestEmail(A,'delivered',config,transport)).rejects.toThrow('EMAIL_PROVIDER_UNAVAILABLE');
 });
 it('denies real-recipient and content injection through the HTTP handler',async()=>{
  const transport=vi.fn();vi.stubGlobal('fetch',transport);
  const r=await mailPost(new Request('http://localhost/api/providers/resend/test',{method:'POST',body:JSON.stringify({scenario:'delivered',to:'real@example.com',text:'private'})}));
  expect(r.status).toBe(400);expect(transport).not.toHaveBeenCalled();
 });
 it('requires an authenticated email caller',async()=>{
  mocks.customer.mockRejectedValue(new Error('UNAUTHENTICATED'));const transport=vi.fn();vi.stubGlobal('fetch',transport);
  expect((await mailPost(new Request('http://localhost',{method:'POST',body:'{"scenario":"delivered"}'}))).status).toBe(401);expect(transport).not.toHaveBeenCalled();
 });
 it('denies an authenticated but unlisted pilot customer',async()=>{
  mocks.customer.mockResolvedValue({id:'00000000-0000-4000-8000-000000000002'});
  expect((await mailPost(new Request('http://localhost',{method:'POST',body:'{"scenario":"delivered"}'}))).status).toBe(403);
 });
 it('returns accepted provider ID without claiming email delivery',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({id:A})));
  const r=await mailPost(new Request('http://localhost',{method:'POST',body:'{"scenario":"delivered"}'}));expect(r.status).toBe(200);expect((await r.json()).deliveryConfirmed).toBe(false);
 });
 it('requires authenticated entitlement reads',async()=>{mocks.customer.mockRejectedValue(new Error('UNAUTHENTICATED'));expect((await entitlementGet()).status).toBe(401);});
 it('defaults webhook to disabled and missing config to unavailable',async()=>{
  vi.stubEnv('NASI_PROVIDER_MODE','');expect((await webhookPost(new Request('http://localhost',{method:'POST'}))).status).toBe(503);
  vi.stubEnv('NASI_PROVIDER_MODE','synthetic-pilot');vi.stubEnv('STRIPE_WEBHOOK_SECRET','');expect((await webhookPost(new Request('http://localhost',{method:'POST'}))).status).toBe(503);
 });
 it('rejects signatures, stale/future headers, tampered bodies and live events before any database access',async()=>{
  const tx=vi.fn();const sql=Object.assign(vi.fn(),{withTenant:tx}) as unknown as SqlClient;const raw=JSON.stringify(event);
  for(const [body,signature] of [[raw,''],[raw,signed(raw,1)],[raw,signed(raw,1400)],[raw+' ',signed(raw)],[JSON.stringify({...event,livemode:true}),signed(JSON.stringify({...event,livemode:true}))],[raw,`t=1000,t=1000,v1=bad`]])await expect(applyStripePilotEvent(body,signature,secret,sql,1000)).rejects.toThrow();
  expect(tx).not.toHaveBeenCalled();
 });
 it('supports rotated multiple signatures but still requires the authentic raw body',async()=>{
  const tx=vi.fn().mockRejectedValue(new Error('DB_REACHED'));const sql=Object.assign(vi.fn(),{withTenant:tx}) as unknown as SqlClient;const raw=JSON.stringify(event);
  await expect(applyStripePilotEvent(raw,`${signed(raw)},v1=${'0'.repeat(64)}`,secret,sql,1000)).rejects.toThrow('DB_REACHED');expect(tx).toHaveBeenCalledWith(A,expect.any(Function));
 });
});
