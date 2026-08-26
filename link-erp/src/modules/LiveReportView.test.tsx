import { beforeEach,describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LiveReportView } from './LiveReportView';

describe('LiveReportView empty states', () => {
  beforeEach(()=>vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,headers:new Headers(),text:async()=> '[]'} as unknown as Response))));
  test('a blank GST report explains what is missing and opens the right workflow', async () => {
    const onOpen = vi.fn();
    render(<LiveReportView report="gst_liability" onOpen={onOpen} />);

    await waitFor(() => expect(screen.getByText(/No approved GST documents/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Open tax invoices/i }));
    expect(onOpen).toHaveBeenCalledWith('sales_invoices');
  });

  test('a user applies and saves a personal filter with its visible export columns',async()=>{
    const writes:unknown[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{const path=String(url).replace(/^.*\/api/,'');if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));return{ok:true,status:201,headers:new Headers(),text:async()=>JSON.stringify({id:'saved'})} as Response;}const body=path.startsWith('/saved-views')?[{id:'v1',name:'Compact cash',filter_text:'Cash',columns:['code','name'],updated_at:'2026-08-26'}]:[{code:'101',name:'Cash',control_account:'Assets',total_debit:100,total_credit:0,balance:100},{code:'201',name:'Supplier',control_account:'Liabilities',total_debit:0,total_credit:100,balance:-100}];return{ok:true,status:200,headers:new Headers(),text:async()=>JSON.stringify(body)} as Response;}));
    render(<LiveReportView report="trial_balance"/>);
    await screen.findByText('Supplier');
    fireEvent.change(screen.getByLabelText('Saved report'),{target:{value:'v1'}});
    await waitFor(()=>expect(screen.queryByText('Supplier')).not.toBeInTheDocument());
    expect(screen.queryByRole('columnheader',{name:'Control A/c'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:/save current/i}));
    await waitFor(()=>expect(writes).toContainEqual({module:'report:trial_balance',name:'Compact cash',filterText:'Cash',columns:['code','name']}));
  });
});
