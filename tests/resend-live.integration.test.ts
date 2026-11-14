import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {sendPilotTestEmail} from '@/lib/providers/resend-pilot';
const file=process.env.NASI_LIVE_RESEND_CREDENTIAL_FILE;
const customer='00000000-0000-4000-8000-000000000001';
const results:Record<string,unknown>={};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
describe.skipIf(!file)('Actual Resend authenticated synthetic provider delivery',()=>{
 let key:string;
 beforeAll(()=>{
  if(realpathSync(file!)!==resolve(homedir(),'.config/nasi/pilot-providers/resend-credentials.json'))throw new Error('EXPLICIT_PILOT_PROFILE_REQUIRED');
  key=JSON.parse(readFileSync(file!,'utf8')).api_key;
  if(!key?.startsWith('re_'))throw new Error('SELECTED_PROVIDER_KEY_REQUIRED');
 });
 afterAll(()=>{
  if(process.env.NASI_RESEND_LIVE_EVIDENCE)writeFileSync(process.env.NASI_RESEND_LIVE_EVIDENCE,JSON.stringify({scope:'ACTUAL_RESEND_API; PROVIDER_TEST_ADDRESSES_AND_SIMULATED_DELIVERY_EVENTS_ONLY',actual_customer_recipient:false,results},null,2)+'\n');
 });
 it.each(['delivered','bounced','complained','suppressed'] as const)('sends fixed %s fixture and independently reads the provider event',async scenario=>{
  await sleep(1100);
  const config={NASI_PROVIDER_MODE:'synthetic-pilot',NASI_PILOT_CUSTOMER_IDS:customer,RESEND_API_KEY:key};
  const accepted=await sendPilotTestEmail(customer,scenario,config);
  expect(accepted.deliveryConfirmed).toBe(false);
  let observed:Record<string,unknown>={};
  for(let i=0;i<30;i++){
   await sleep(1100);
   const response=await fetch('https://api.resend.com/emails/'+accepted.id,{redirect:'error',headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(10000)});
   if(response.status===429)continue;
   if(!response.ok)throw new Error('OWN_TEST_EMAIL_READBACK_DENIED_'+response.status);
   observed=await response.json();
   if(observed.last_event===scenario)break;
  }
  results[scenario]={id:accepted.id,last_event:observed.last_event,recipient:observed.to,provider_sender:observed.from};
  expect(observed.id).toBe(accepted.id);expect(observed.to).toEqual([scenario+'@resend.dev']);expect(observed.last_event).toBe(scenario);
 },60000);
 it('deduplicates an identical accepted synthetic message',async()=>{
  await sleep(1100);const r=await sendPilotTestEmail(customer,'delivered',{NASI_PROVIDER_MODE:'synthetic-pilot',NASI_PILOT_CUSTOMER_IDS:customer,RESEND_API_KEY:key});
  expect(r.id).toBe((results.delivered as {id:string}).id);results.idempotent_retry_same_id=true;
 });
});
