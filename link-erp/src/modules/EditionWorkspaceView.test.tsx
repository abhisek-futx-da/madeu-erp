import {beforeEach,describe,expect,test,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {EditionWorkspaceView} from './EditionWorkspaceView';
import type {Session} from '../lib/api';
import {clearApiCache} from '../lib/useApi';

const sent:Array<{path:string;body:any}>=[];
const session:Session={userId:'u1',tenantId:'t1',role:'owner',permissions:['write:owner','write:store','write:sales'],activeLocation:null,tenant:{legalName:'Pilot',gstin:'27ABCDE1234F1Z5',fyLabel:'2026-27'},user:{email:'owner@pilot.test',fullName:'Owner'}};
const document={id:'00000000-0000-0000-0000-000000000901',edition:'weaving',doc_type:'loom_plan',doc_no:'WLP/26-27/1',doc_date:'2026-08-27',status:'draft',payload:{loomNo:'L-12',plannedMetres:450},remarks:'Day plan',party:null,location:null};

beforeEach(()=>{sent.length=0;clearApiCache();vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
  const path=String(url).replace(/^.*\/api/,'');
  if(init?.method==='POST'){const body=JSON.parse(String(init.body??'{}'));sent.push({path,body});return{ok:true,status:201,headers:new Headers(),text:async()=>JSON.stringify({id:'saved',...body})} as Response;}
  const data:Record<string,unknown>={
    '/editions/catalog':[{key:'weaving',label:'Weaving',resourceTypes:['yarn','beam','loom'],workflows:[{type:'loom_plan',label:'Loom plan',fields:[{key:'loomNo',label:'Loom number',type:'text',required:true},{key:'plannedMetres',label:'Planned metres',type:'number',required:true,unit:'m'}]}]}],
    '/editions':[{edition:'weaving',is_enabled:true,documents:1,in_progress:0}],
    '/editions/weaving/documents?docType=loom_plan&limit=200':{rows:[document],total:1,limit:200,offset:0},
    '/editions/weaving/documents?limit=500':{rows:[document],total:1,limit:500,offset:0},
    '/editions/weaving/resources':[{id:'00000000-0000-0000-0000-000000000902',resource_type:'yarn',code:'YRN-60',name:'60 count yarn',uom:'KGS',quantity:100,value_paise:5000000,average_rate_paise:50000,is_active:true}],
    [`/editions/weaving/documents/${document.id}/lines`]:{lines:[],costing:{material_paise:0,labour_paise:0,machine_paise:0,logistics_duty_paise:0,other_paise:0,total_cost_paise:0}}
  };
  return{ok:true,status:200,headers:new Headers(),text:async()=>JSON.stringify(data[path]??[])} as Response;
}));});

describe('parallel edition workspace',()=>{
  test('creates a validated weaving workflow document through the shared edition UI',async()=>{
    render(<EditionWorkspaceView edition="weaving" session={session}/>);
    fireEvent.change(await screen.findByLabelText('Loom number'),{target:{value:'L-18'}});
    fireEvent.change(screen.getByLabelText('Planned metres'),{target:{value:'725'}});
    // The screen loads a catalogue, a document list and a resource list. Wait
    // for the button to mean something rather than clicking while it is still
    // inert — under load those fetches settle after the fields have rendered.
    const create=screen.getByRole('button',{name:'Create draft'});
    await waitFor(()=>expect(create).toBeEnabled());
    fireEvent.click(create);
    await waitFor(()=>expect(sent.some(call=>call.path==='/editions/weaving/documents')).toBe(true));
    expect(sent.find(call=>call.path==='/editions/weaving/documents')!.body).toEqual(expect.objectContaining({docType:'loom_plan',payload:{loomNo:'L-18',plannedMetres:725}}));
  });

  test('starts an edition document using the guarded lifecycle endpoint',async()=>{
    render(<EditionWorkspaceView edition="weaving" session={session}/>);
    const start=await screen.findByRole('button',{name:'Start'});
    await waitFor(()=>expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(()=>expect(sent.find(call=>call.path.endsWith('/status'))?.body).toEqual({status:'in_progress',reason:''}));
  });

  test('lets an owner pause a single edition without disabling the shared ERP',async()=>{
    render(<EditionWorkspaceView edition="weaving" session={session}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Pause edition'}));
    await waitFor(()=>expect(sent.find(call=>call.path==='/editions/config')?.body).toEqual({edition:'weaving',isEnabled:false,config:{}}));
  });

  test('adds a governed resource to the edition stock ledger',async()=>{
    render(<EditionWorkspaceView edition="weaving" session={session}/>);
    fireEvent.change(await screen.findByLabelText('Edition resource code'),{target:{value:'BEAM-88'}});
    fireEvent.change(screen.getByLabelText('Edition resource name'),{target:{value:'Warp beam 88'}});
    fireEvent.change(screen.getByLabelText('Edition opening quantity'),{target:{value:'1'}});
    fireEvent.change(screen.getByLabelText('Edition opening value'),{target:{value:'25000'}});
    fireEvent.click(screen.getByRole('button',{name:'Add resource'}));
    await waitFor(()=>expect(sent.find(call=>call.path==='/editions/weaving/resources')?.body).toEqual(expect.objectContaining({code:'BEAM-88',name:'Warp beam 88',openingQty:1,openingValue:25000})));
  });

  test('records material and cost lines against an operational document',async()=>{
    render(<EditionWorkspaceView edition="weaving" session={session}/>);
    fireEvent.click(await screen.findByLabelText('Materials and costing for WLP/26-27/1'));
    await screen.findByText('Total');
    fireEvent.click(await screen.findByRole('button',{name:'Add line'}));
    fireEvent.change(screen.getByLabelText('Line resource 1'),{target:{value:'00000000-0000-0000-0000-000000000902'}});
    fireEvent.change(screen.getByLabelText('Line quantity 1'),{target:{value:'20'}});
    fireEvent.change(screen.getByLabelText('Line rate 1'),{target:{value:'500'}});
    fireEvent.click(screen.getByRole('button',{name:'Save lines'}));
    await waitFor(()=>expect(sent.find(call=>call.path.endsWith('/lines'))?.body.lines[0]).toEqual(expect.objectContaining({resourceId:'00000000-0000-0000-0000-000000000902',lineKind:'consume',quantity:20,ratePaise:50000,amountPaise:1000000})));
  });
});
