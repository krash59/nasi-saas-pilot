import { createHash } from 'node:crypto';
import { z } from 'zod';

export const mailScenario=z.enum(['delivered','bounced','complained','suppressed']);
type Config=Record<string,string|undefined>;
/** Only synthetic fixed content to provider-owned test recipients is supported. */
export async function sendPilotTestEmail(customerId:string, scenario:z.infer<typeof mailScenario>, config:Config=process.env, transport:typeof fetch=fetch) {
  if(config.NASI_PROVIDER_MODE!=='synthetic-pilot') throw new Error('PILOT_DISABLED');
  if(!z.string().uuid().safeParse(customerId).success || !(config.NASI_PILOT_CUSTOMER_IDS??'').split(',').map(s=>s.trim()).includes(customerId)) throw new Error('PILOT_CUSTOMER_DENIED');
  const parsed=mailScenario.safeParse(scenario);
  if(!parsed.success) throw new Error('INVALID_MAIL_SCENARIO');
  const key=config.RESEND_API_KEY;
  if(!key?.startsWith('re_')||key.length<=3) throw new Error('EMAIL_NOT_CONFIGURED');
  const idempotency=createHash('sha256').update(`${customerId}:${scenario}:${Math.floor(Date.now()/3600000)}`).digest('hex');
  try {
    const response=await transport('https://api.resend.com/emails',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','Idempotency-Key':`nasi-pilot-${idempotency}`},
      body:JSON.stringify({from:'NASI Pilot <onboarding@resend.dev>',to:[`${scenario}@resend.dev`],subject:'Synthetic NASI delivery check',text:'Synthetic nonproduction integration fixture. No customer data.'}),
    });
    if(!response.ok) throw new Error('UPSTREAM_DENIED');
    const result=z.object({id:z.string().uuid()}).parse(await response.json());
    return {id:result.id,provider:'resend',scope:'synthetic-test-recipient',deliveryConfirmed:false};
  } catch {throw new Error('EMAIL_PROVIDER_UNAVAILABLE');}
}
