import { NextResponse } from 'next/server';
import { requireCustomer } from '@/lib/tenant/customer';
import { getSql } from '@/lib/db/client';
import { readPilotEntitlement } from '@/lib/providers/stripe-pilot';
export async function GET() {
  if(process.env.NASI_PROVIDER_MODE!=='synthetic-pilot') return NextResponse.json({error:'PILOT_DISABLED'},{status:503});
  try {
    const customer=await requireCustomer();
    return NextResponse.json(await readPilotEntitlement(getSql(process.env.DATABASE_URL!),customer.id));
  } catch(e) {return NextResponse.json({error:e instanceof Error && e.message==='UNAUTHENTICATED'?'UNAUTHENTICATED':'ENTITLEMENT_UNAVAILABLE'},{status:e instanceof Error && e.message==='UNAUTHENTICATED'?401:503});}
}
