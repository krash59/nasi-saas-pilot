import {beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({project:vi.fn(),stage:vi.fn(),authorize:vi.fn()}));
vi.mock('@/lib/design/repository',()=>({getProjectForCustomer:mock.project,getProjectStageInfo:mock.stage}));
vi.mock('@/lib/design/implementation-consent',()=>({authorizeImplementation:mock.authorize}));
import {PUT} from '@/app/api/projects/[projectId]/design/summary/route';
import {canAuthorizeAgenticImplementation} from '@/lib/design/stage-gate';
const ctx={params:Promise.resolve({projectId:'00000000-0000-4000-8000-000000000001'})};
const request=(body:unknown)=>new Request('http://localhost/summary',{method:'PUT',body:JSON.stringify(body)});
describe('Explicit implementation consent boundary',()=>{
 beforeEach(()=>{vi.resetAllMocks();mock.project.mockResolvedValue({id:'own'});mock.stage.mockResolvedValue({summary_status:'approved'});});
 it.each([{}, {confirmed:false,reviewedContent:{}},{confirmed:true},{confirmed:true,reviewedContent:{},actor:'agent'},{confirmed:true,reviewedContent:{},nwsAuthorized:true}])('rejects missing confirmation or caller-injected authority',async body=>{
  expect((await PUT(request(body),ctx)).status).toBe(400);expect(mock.authorize).not.toHaveBeenCalled();
 });
 it('records customer consent without granting execution or release',async()=>{
  mock.authorize.mockResolvedValue({consent:{id:'record'},nwsExecutionAuthorized:false,productionReleaseAuthorized:false});
  const response=await PUT(request({confirmed:true,reviewedContent:{intent:'reviewed'}}),ctx);
  expect(response.status).toBe(201);expect((await response.json()).nwsExecutionAuthorized).toBe(false);
 });
 it('denies cross-tenant project',async()=>{mock.project.mockResolvedValue(null);expect((await PUT(request({confirmed:true,reviewedContent:{}}),ctx)).status).toBe(404);expect(mock.authorize).not.toHaveBeenCalled();});
 it('requires authentication',async()=>{mock.project.mockRejectedValue(new Error('UNAUTHENTICATED'));expect((await PUT(request({}),ctx)).status).toBe(401);});
 it('denies stale reviewed DIR',async()=>{mock.authorize.mockRejectedValue(new Error('APPROVED_DIR_REVIEW_MISMATCH'));expect((await PUT(request({confirmed:true,reviewedContent:{}}),ctx)).status).toBe(409);});
 it('denies unapproved summary',async()=>{mock.stage.mockResolvedValue({summary_status:'draft'});expect((await PUT(request({confirmed:true,reviewedContent:{}}),ctx)).status).toBe(403);});
 it('does not turn summary approval alone into implementation permission',()=>expect(canAuthorizeAgenticImplementation({lifecycle_stage:'dir',summary_status:'approved'})).toBe(false));
 it('binds consent to customer, project and current DIR with expiry',()=>{
  const c={projectId:'p',customerId:'a',approvedDirHash:'a'.repeat(64),consentProjectId:'p',consentCustomerId:'a',consentDirHash:'a'.repeat(64),approvedDir:true,expiresAt:Date.now()+60000,revoked:false};
  const p={lifecycle_stage:'agile_bdd',summary_status:'approved',implementation:c};expect(canAuthorizeAgenticImplementation(p)).toBe(true);
  for(const bad of [{consentCustomerId:'other'},{consentProjectId:'other'},{consentDirHash:'b'.repeat(64)},{expiresAt:0},{revoked:true},{approvedDir:false}])expect(canAuthorizeAgenticImplementation({...p,implementation:{...c,...bad}})).toBe(false);
 });
});
