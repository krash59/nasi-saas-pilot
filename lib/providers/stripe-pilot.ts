import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { withCustomerContext, type SqlClient } from '@/lib/db/client';

const status = z.enum(['active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused']);
const eventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]+$/),
  type: z.enum(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted']),
  created: z.number().int().positive().safe(), livemode: z.literal(false),
  data: z.object({ object: z.object({
    id: z.string().regex(/^sub_[A-Za-z0-9_]+$/), object: z.literal('subscription'),
    customer: z.string().regex(/^cus_[A-Za-z0-9_]+$/), livemode: z.literal(false), status,
    metadata: z.object({ tenant_id: z.string().uuid() }),
  }) }),
});

/** Authenticate the unmodified body before parsing or accessing any tenant. */
export async function applyStripePilotEvent(
  raw: string, signature: string, secret: string, sql: SqlClient,
  nowSeconds = Math.floor(Date.now()/1000),
) {
  if (!secret.startsWith('whsec_') || secret.length <= 6) throw new Error('WEBHOOK_NOT_CONFIGURED');
  if (Buffer.byteLength(raw)>262144) throw new Error('INVALID_WEBHOOK');
  const parts=signature.split(',').map(p=>p.trim().split('='));
  const times=parts.filter(p=>p[0]==='t').map(p=>p[1]);
  if(times.length!==1 || !/^\d+$/.test(times[0])) throw new Error('INVALID_SIGNATURE');
  const timestamp=Number(times[0]);
  if(!Number.isSafeInteger(timestamp)||Math.abs(nowSeconds-timestamp)>300) throw new Error('INVALID_SIGNATURE');
  const expected=createHmac('sha256',secret).update(`${timestamp}.${raw}`).digest();
  const valid=parts.some(([key,value])=>key==='v1' && /^[0-9a-f]{64}$/.test(value ?? '') && timingSafeEqual(expected,Buffer.from(value,'hex')));
  if(!valid) throw new Error('INVALID_SIGNATURE');
  let event: z.infer<typeof eventSchema>;
  try {event=eventSchema.parse(JSON.parse(raw));} catch {throw new Error('INVALID_WEBHOOK');}
  if(event.created>nowSeconds+300) throw new Error('INVALID_WEBHOOK');
  const sub=event.data.object;
  if(event.type==='customer.subscription.deleted' && sub.status!=='canceled') throw new Error('INVALID_WEBHOOK');
  return withCustomerContext(sql,sub.metadata.tenant_id,async tx=>{
    const accounts=await tx`SELECT * FROM pilot_billing_accounts WHERE customer_id=${sub.metadata.tenant_id}::uuid FOR UPDATE`;
    const account=accounts[0];
    if(!account || account.stripe_customer_id!==sub.customer || account.stripe_subscription_id!==sub.id) throw new Error('SUBSCRIPTION_BINDING_MISMATCH');
    const seen=await tx`SELECT event_id FROM pilot_billing_events WHERE event_id=${event.id}`;
    if(seen.length) return {decision:'DUPLICATE' as const};
    // Equal-second conflicting events require reconciliation, never an arbitrary
    // arrival-order entitlement increase. Event IDs have no chronological order.
    if(event.created<Number(account.last_event_created)) throw new Error('STALE_OR_AMBIGUOUS_EVENT');
    if(event.created===Number(account.last_event_created)) {
      await tx`INSERT INTO pilot_billing_events(event_id,customer_id,event_created) VALUES(${event.id},${sub.metadata.tenant_id}::uuid,${event.created})`;
      await tx`UPDATE pilot_billing_accounts SET reconciliation_required=true WHERE customer_id=${sub.metadata.tenant_id}::uuid`;
      return {decision:'RECONCILIATION_REQUIRED' as const};
    }
    await tx`INSERT INTO pilot_billing_events(event_id,customer_id,event_created) VALUES(${event.id},${sub.metadata.tenant_id}::uuid,${event.created})`;
    await tx`UPDATE pilot_billing_accounts SET status=${sub.status},last_event_created=${event.created},last_event_id=${event.id},reconciliation_required=false WHERE customer_id=${sub.metadata.tenant_id}::uuid`;
    return {decision:'APPLIED' as const};
  });
}

export async function readPilotEntitlement(sql: SqlClient, customerId: string) {
  return withCustomerContext(sql,customerId,async tx=>{
    const rows=await tx`SELECT status,reconciliation_required FROM pilot_billing_accounts WHERE customer_id=${customerId}::uuid`;
    const state=rows[0]?.status ?? 'inactive';
    return {subscriptionStatus:state,reconciliationRequired:rows[0]?.reconciliation_required===true,designExportEnabled:rows[0]?.reconciliation_required!==true && (state==='active'||state==='trialing'),
      nwsExecutionAuthorized:false,productionReleaseAuthorized:false};
  });
}
