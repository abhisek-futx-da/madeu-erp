import {beforeEach,describe,expect,test,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {DocumentAttachments} from './DocumentAttachments';

const sent:unknown[]=[];
beforeEach(()=>{sent.length=0;vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>{if(init?.method==='POST'){sent.push(JSON.parse(String(init.body)));return{ok:true,status:201,headers:new Headers(),text:async()=>JSON.stringify({id:'a1'})} as Response;}return{ok:true,status:200,headers:new Headers(),text:async()=> '[]'} as Response;}));});

describe('DocumentAttachments',()=>{
  test('uploads signed evidence with its document identity and note',async()=>{
    render(<DocumentAttachments docType="sales_invoice" docId="00000000-0000-0000-0000-000000000001" label="INV/1" onClose={vi.fn()}/>);
    const file=new File([new Uint8Array([37,80,68,70,45,49,46,52])],'signed.pdf',{type:'application/pdf'});
    const input=screen.getByText('Choose PDF/JPEG/PNG').closest('label')!.querySelector('input')!;
    fireEvent.change(input,{target:{files:[file]}});
    fireEvent.change(screen.getByPlaceholderText('Evidence note (optional)'),{target:{value:'Customer signed copy'}});
    fireEvent.click(screen.getByRole('button',{name:'Upload evidence'}));
    await waitFor(()=>expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual(expect.objectContaining({docType:'sales_invoice',docId:'00000000-0000-0000-0000-000000000001',fileName:'signed.pdf',contentType:'application/pdf',note:'Customer signed copy'}));
  });
});
