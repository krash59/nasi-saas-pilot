import {afterEach,describe,expect,it,vi} from 'vitest';
import {NextRequest,NextResponse} from 'next/server';
// BDD_F08_01: an agent service identity is forbidden on every HITL approval route, in every auth mode.
const m=vi.hoisted(()=>({clerk:vi.fn()}));
vi.mock('@clerk/nextjs/server',()=>({clerkMiddleware:()=>m.clerk,createRouteMatcher:()=>()=>false}));
import middleware from '@/middleware';
import {isHitlRoute} from '@/lib/security/agent';
const P='/api/projects/00000000-0000-4000-8000-000000000001';
const HITL:[string,string][]=[['POST',P+'/design/summary'],['PUT',P+'/design/summary'],['DELETE',P+'/design/summary'],['POST',P+'/dir/approve'],['POST',P+'/release-authorization'],['POST','/api/account/offboard']];
const AGENT:Record<string,string>[]=[{'x-nasi-agent-token':'any'},{authorization:'Bearer nasi_agent_synthetic'}];
afterEach(()=>vi.unstubAllEnvs());
describe('BDD_F08_01 agents cannot perform HITL approvals',()=>{
 for(const mode of ['dev-auth','clerk'])
  it.each(HITL)(`forbids agents: %s %s (${mode})`,async(method,path)=>{
   if(mode==='dev-auth'){vi.stubEnv('ENABLE_DEV_AUTH','1');vi.stubEnv('NODE_ENV','development');}else{vi.stubEnv('ENABLE_DEV_AUTH','0');vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY','pk_test_synthetic');}
   m.clerk.mockReset();m.clerk.mockReturnValue(NextResponse.next());
   for(const headers of AGENT){
    const r=await middleware(new NextRequest('http://localhost'+path,{method,headers}),{});
    expect(r?.status).toBe(403);expect(await r?.json()).toEqual({error:'AGENT_HITL_FORBIDDEN'});
   }
   expect(m.clerk).not.toHaveBeenCalled();
  });
 it('leaves agent read paths and human HITL requests to the normal auth path',async()=>{
  vi.stubEnv('ENABLE_DEV_AUTH','1');vi.stubEnv('NODE_ENV','development');
  expect((await middleware(new NextRequest('http://localhost'+P+'/design/summary',{headers:AGENT[0]}),{}))?.status).toBe(200);   // GET read allowed
  expect((await middleware(new NextRequest('http://localhost'+P+'/dir/approve',{method:'POST'}),{}))?.status).toBe(200);          // human passes to handler
 });
 it('matches only exact HITL routes',()=>{
  expect(isHitlRoute('POST',P+'/dir/approve')).toBe(true);
  expect(isHitlRoute('GET',P+'/dir')).toBe(false);
  expect(isHitlRoute('POST',P+'/design/messages')).toBe(false);
 });
});
