import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({create:vi.fn(),project:vi.fn(),append:vi.fn(),open:vi.fn(),conversation:vi.fn(),fields:vi.fn(),messages:vi.fn(),merge:vi.fn(),reply:vi.fn(),summary:vi.fn(),stage:vi.fn(),approve:vi.fn(),confirm:vi.fn(),cap:vi.fn(),meter:vi.fn()}));
vi.mock('@/lib/tenant/customer',()=>({createProject:m.create,requireCustomer:vi.fn()}));
vi.mock('@/lib/design/repository',()=>({getProjectForCustomer:m.project,appendDesignMessage:m.append,assertDesignChatOpen:m.open,ensureDesignConversationStarted:m.conversation,getSummaryFields:m.fields,listDesignMessages:m.messages,mergeAiProposedFields:m.merge,getOrCreateSummary:m.summary,getProjectStageInfo:m.stage,approveDesignSummary:m.approve,confirmSummaryField:m.confirm}));
vi.mock('@/lib/design/openai',()=>({generateDesignAssistantReply:m.reply,getDesignAssistantMode:()=>"openai"}));
vi.mock('@/lib/usage/repository',()=>({assertDesignTokensAvailable:m.cap,recordProjectUsage:m.meter}));
vi.mock('@/lib/design/dir-repository',()=>({generateDirDraft:vi.fn()}));
const ix=vi.hoisted(()=>({fail:'',mode:'legacy',sql:[] as string[],view:{active_question_id:'q02_problem',questions:[],open_items:[],gate:{pass:false,issues:[]}}}));
vi.mock('@/lib/intake/repository',()=>({
  withIntake:async(_p:string,fn:(tx:unknown,c:string,v:unknown,e:unknown[])=>unknown)=>fn(Object.assign((strs:TemplateStringsArray)=>{ix.sql.push(strs.join('?'));if(ix.fail)return Promise.reject(new Error(ix.fail));return Promise.resolve([{id:'00000000-0000-0000-0000-000000000001'}]);},{}),'cust',ix.view,[]),
  intakeModeTx:async()=>ix.mode,
  appendIntakeEventsTx:vi.fn(async()=>ix.view),
}));
vi.mock('@/lib/design/implementation-consent',()=>({authorizeImplementation:vi.fn()}));
import {UsageCapExceededError} from '@/lib/usage/meters';
import {POST as projectPost} from '@/app/api/projects/route';
import {GET as messagesGet,POST as messagesPost} from '@/app/api/projects/[projectId]/design/messages/route';
import {GET as summaryGet,POST as summaryPost} from '@/app/api/projects/[projectId]/design/summary/route';
const ctx={params:Promise.resolve({projectId:'00000000-0000-4000-8000-000000000001'})};
const req=(body:unknown)=>new Request('http://localhost/api',{method:'POST',body:JSON.stringify(body)});
const detail='internal_fixture_password=must_not_escape';
describe('Customer API failure and authority boundaries',()=>{
 beforeEach(()=>{vi.resetAllMocks();m.project.mockResolvedValue({id:'own'});m.open.mockResolvedValue(undefined);m.messages.mockResolvedValue([]);m.fields.mockResolvedValue({});m.reply.mockResolvedValue({content:'Safe reply',isAiDraft:true,proposals:{}});});
 it('sanitizes project creation failures',async()=>{m.create.mockRejectedValue(new Error(detail));const r=await projectPost(req({name:'demo'}));expect(r.status).toBe(500);expect(await r.json()).toEqual({error:'PROJECT_CREATE_FAILED'});});
 it('returns authentication failure without an internal error',async()=>{m.create.mockRejectedValue(new Error('UNAUTHENTICATED'));expect((await projectPost(req({name:'demo'}))).status).toBe(401);});
 it('rejects project authority injection',async()=>{expect((await projectPost(req({name:'demo',customer_id:'other'}))).status).toBe(400);expect(m.create).not.toHaveBeenCalled();});
 it('sanitizes message read failures',async()=>{m.conversation.mockRejectedValue(new Error(detail));const r=await messagesGet(new Request('http://localhost'),ctx);expect(r.status).toBe(500);expect(await r.json()).toEqual({error:'DESIGN_MESSAGES_READ_FAILED'});});
 it('handles message-read authentication',async()=>{m.project.mockRejectedValue(new Error('UNAUTHENTICATED'));expect((await messagesGet(new Request('http://localhost'),ctx)).status).toBe(401);});
 it('denies another tenant before reading messages',async()=>{m.project.mockResolvedValue(null);expect((await messagesGet(new Request('http://localhost'),ctx)).status).toBe(404);expect(m.conversation).not.toHaveBeenCalled();});
 it('sanitizes message persistence failures',async()=>{ix.fail=detail;const r=await messagesPost(req({message:'hello'}),ctx);ix.fail='';expect(r.status).toBe(500);expect(await r.json()).toEqual({error:'DESIGN_MESSAGE_FAILED'});});
 it('chat makes no AI call and stores the customer words plus a fixed reply',async()=>{ix.sql=[];const r=await messagesPost(req({message:'hello'}),ctx);expect(r.status).toBe(200);expect(m.reply).not.toHaveBeenCalled();expect(m.meter).not.toHaveBeenCalled();expect(ix.sql.filter(q=>q.includes('INSERT INTO design_messages'))).toHaveLength(2);expect((await r.json()).assistantMode).toBe('deterministic');});
 it('preserves closed-discussion conflict',async()=>{m.open.mockRejectedValue(new Error('DESIGN_DISCUSSION_CLOSED'));expect((await messagesPost(req({message:'hello'}),ctx)).status).toBe(409);expect(m.append).not.toHaveBeenCalled();});
 it('rejects caller-injected assistant role',async()=>{expect((await messagesPost(req({message:'hello',role:'assistant'}),ctx)).status).toBe(400);expect(m.append).not.toHaveBeenCalled();});
 it('v3 refuses a bare negative and asks for the None button',async()=>{ix.mode='v3';ix.sql=[];const r=await messagesPost(req({message:'n/a'}),ctx);ix.mode='legacy';expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'USE_NONE_BUTTON'});expect(ix.sql).toHaveLength(0);});
 it('still accepts an ordinary customer message',async()=>{ix.sql=[];expect((await messagesPost(req({message:'hello'}),ctx)).status).toBe(200);expect(ix.sql.some(q=>q.includes("'customer'"))).toBe(true);});
 it('sanitizes summary read failures',async()=>{m.summary.mockRejectedValue(new Error(detail));const r=await summaryGet(new Request('http://localhost'),ctx);expect(r.status).toBe(500);expect(await r.json()).toEqual({error:'DESIGN_SUMMARY_READ_FAILED'});});
 it('handles summary-write authentication before any mutation',async()=>{m.project.mockRejectedValue(new Error('UNAUTHENTICATED'));expect((await summaryPost(req({action:'approve'}),ctx)).status).toBe(401);expect(m.approve).not.toHaveBeenCalled();});
 it('sanitizes summary-write failures',async()=>{m.approve.mockRejectedValue(new Error(detail));const r=await summaryPost(req({action:'approve'}),ctx);expect(r.status).toBe(500);expect(await r.json()).toEqual({error:'DESIGN_SUMMARY_UPDATE_FAILED'});});
 it('rejects summary approval authority injection',async()=>{expect((await summaryPost(req({action:'approve',actor:'agent'}),ctx)).status).toBe(400);expect(m.approve).not.toHaveBeenCalled();});
 it.each([null, [], 'not-an-object'])('classifies invalid summary JSON as a client error',async body=>{expect((await summaryPost(req(body),ctx)).status).toBe(400);expect(m.approve).not.toHaveBeenCalled();});
});
