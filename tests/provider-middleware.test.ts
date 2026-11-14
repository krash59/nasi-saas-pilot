import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {NextRequest,NextResponse} from 'next/server';
const m=vi.hoisted(()=>({clerk:vi.fn()}));
vi.mock('@clerk/nextjs/server',()=>({clerkMiddleware:()=>m.clerk,createRouteMatcher:()=>()=>false}));
import middleware from '@/middleware';
beforeEach(()=>{vi.stubEnv('NASI_PROVIDER_MODE','disabled');vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY','pk_test_synthetic');m.clerk.mockReset();m.clerk.mockReturnValue(NextResponse.json({auth:'required'},{status:401}));});
afterEach(()=>vi.unstubAllEnvs());
it.each(['/api/health','/api/providers/stripe/webhook'])('keeps exact service callback %s available during hosted identity failure',async path=>{
 m.clerk.mockImplementation(()=>{throw new Error('IDENTITY_PROVIDER_UNAVAILABLE')});expect((await middleware(new NextRequest('http://localhost'+path),{}))?.status).toBe(200);expect(m.clerk).not.toHaveBeenCalled();
});
it.each(['/api/billing/entitlement','/api/providers/resend/test','/api/providers/stripe/webhook/extra','/api/health/private'])('keeps Clerk at the protected boundary %s',async path=>{
 expect((await middleware(new NextRequest('http://localhost'+path,{headers:{Authorization:'Bearer synthetic-invalid-token'}}),{}))?.status).toBe(401);expect(m.clerk).toHaveBeenCalled();
});
it('denies missing API credentials without waiting on hosted auth',async()=>{
 m.clerk.mockImplementation(()=>{throw new Error('IDENTITY_PROVIDER_UNAVAILABLE')});expect((await middleware(new NextRequest('http://localhost/api/billing/entitlement'),{}))?.status).toBe(401);expect(m.clerk).not.toHaveBeenCalled();
});
it('still requires Clerk validation for a browser session cookie',async()=>{
 expect((await middleware(new NextRequest('http://localhost/api/billing/entitlement',{headers:{cookie:'__session=synthetic-invalid-token'}}),{}))?.status).toBe(401);expect(m.clerk).toHaveBeenCalled();
});
it.each(['/api/billing/entitlement','/api/providers/resend/test','/api/projects','/api/projects/00000000-0000-4000-8000-000000000001/dir','/api/projects/00000000-0000-4000-8000-000000000001/dir/approve','/api/projects/00000000-0000-4000-8000-000000000001/design/summary'])('routes pilot bearer credentials to the Node validator at %s',async path=>{
 vi.stubEnv('NASI_PROVIDER_MODE','synthetic-pilot');expect((await middleware(new NextRequest('http://localhost'+path,{headers:{Authorization:'Bearer invalid-fixture'}}),{}))?.status).toBe(200);expect(m.clerk).not.toHaveBeenCalled();
});
