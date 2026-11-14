import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db/client';
import { applyStripePilotEvent } from '@/lib/providers/stripe-pilot';
export const runtime='nodejs';
export async function POST(req:Request) {
  if(process.env.NASI_PROVIDER_MODE!=='synthetic-pilot') return NextResponse.json({error:'PILOT_DISABLED'},{status:503});
  const secret=process.env.STRIPE_WEBHOOK_SECRET;
  if(!secret || !process.env.DATABASE_URL) return NextResponse.json({error:'PROVIDER_NOT_CONFIGURED'},{status:503});
  if(Number(req.headers.get('content-length'))>262144) return NextResponse.json({error:'INVALID_WEBHOOK'},{status:413});
  try {
    const result=await applyStripePilotEvent(await req.text(),req.headers.get('stripe-signature')??'',secret,getSql(process.env.DATABASE_URL));
    return NextResponse.json(result);
  } catch(e) {
    const known=e instanceof Error && ['INVALID_SIGNATURE','INVALID_WEBHOOK','SUBSCRIPTION_BINDING_MISMATCH','STALE_OR_AMBIGUOUS_EVENT'].includes(e.message);
    return NextResponse.json({error:known?'WEBHOOK_REJECTED':'WEBHOOK_UNAVAILABLE'},{status:known?400:503});
  }
}
