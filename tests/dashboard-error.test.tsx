import {beforeEach,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
const m=vi.hoisted(()=>({list:vi.fn()}));
vi.mock('@/lib/tenant/customer',()=>({listProjectsForCurrentCustomer:m.list}));
vi.mock('@/app/dashboard/NewProjectForm',()=>({NewProjectForm:()=>null}));
import Dashboard from '@/app/dashboard/page';
beforeEach(()=>vi.resetAllMocks());
it('does not disclose backend exception details to the customer',async()=>{
  m.list.mockRejectedValue(new Error('postgresql://private_fixture:private_password@private-host/db SQLSTATE 42501'));
  const html=renderToStaticMarkup(await Dashboard());
  expect(html).toContain('We could not load your projects. Please try again.');
  for(const privateText of ['private_fixture','private_password','private-host','42501','Setup required'])expect(html).not.toContain(privateText);
});
