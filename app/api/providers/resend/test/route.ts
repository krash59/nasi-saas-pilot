import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCustomer } from '@/lib/tenant/customer';
import { mailScenario,sendPilotTestEmail } from '@/lib/providers/resend-pilot';
const bodySchema=z.object({scenario:mailScenario}).strict();
export async function POST(req:Request) {
  if(process.env.NASI_PROVIDER_MODE!=='synthetic-pilot') return NextResponse.json({error:'PILOT_DISABLED'},{status:503});
  try {
    const customer=await requireCustomer();
    const {scenario}=bodySchema.parse(await req.json());
    return NextResponse.json(await sendPilotTestEmail(customer.id,scenario));
  } catch(e) {
    const code=e instanceof Error?e.message:'';
    const status=code==='UNAUTHENTICATED'?401:code==='PILOT_CUSTOMER_DENIED'?403:e instanceof z.ZodError||e instanceof SyntaxError?400:503;
    return NextResponse.json({error:status===401?'UNAUTHENTICATED':status===403?'PILOT_CUSTOMER_DENIED':status===400?'INVALID_TEST_EMAIL_REQUEST':'TEST_EMAIL_UNAVAILABLE'},{status});
  }
}
