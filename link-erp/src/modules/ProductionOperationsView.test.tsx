import {beforeEach,describe,expect,test,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {CommercialFoundationView} from './CommercialFoundationView';
import {LocationTransferView} from './LocationTransferView';
import type {Session} from '../lib/api';
import {clearApiCache} from '../lib/useApi';

const MAIN='00000000-0000-0000-0000-000000000101';const BRANCH='00000000-0000-0000-0000-000000000102';
const QUALITY='00000000-0000-0000-0000-000000000201';const HOUSE='00000000-0000-0000-0000-000000000302';
const sent:Array<{path:string;body:any}>=[];
const session:Session={userId:'u1',tenantId:'t1',role:'owner',permissions:['write:owner','write:store'],
  activeLocation:{id:MAIN,code:'MAIN',name:'Main office / godown'},tenant:{legalName:'Pilot',gstin:'27ABCDE1234F1Z5',fyLabel:'2026-27'},user:{email:'owner@pilot.test',fullName:'Owner'}};

beforeEach(()=>{sent.length=0;clearApiCache();vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
  const pathWithQuery=String(url).replace(/^.*\/api/,'');const path=pathWithQuery.split('?')[0]!;
  if(init?.method==='POST'){const body=JSON.parse(String(init.body??'{}'));sent.push({path,body});return {ok:true,status:201,headers:new Headers(),text:async()=>JSON.stringify({id:'new',batchNo:'OS/26-27/1',transferNo:'LT/26-27/1'})} as Response;}
  const bodies:Record<string,unknown>={
    '/locations':[{id:MAIN,code:'MAIN',name:'Main office / godown',kind:'registered_office',state_code:'27',is_default:true,is_active:true},{id:BRANCH,code:'B2',name:'Branch Godown',kind:'godown',state_code:'27',is_default:false,is_active:true}],
    '/readiness/foundation':{fyLabel:'2026-27',postedVouchers:0,ready:false,checks:[{key:'inventory',label:'Physical opening stock matches inventory opening ledgers',pass:false,detail:'Stock ₹0.00 · books ₹10,000.00'}]},
    '/opening-outstandings':[],'/opening-stock':{rows:[],total:0,limit:20,offset:0},
    '/ledgers':[{id:'00000000-0000-0000-0000-000000000301',code:'C-1',name:'Customer One'},{id:HOUSE,code:'PH-1',name:'Bombay Crimpers'}],'/qualities':[{id:QUALITY,code:'PC',name:'Pilot Cloth'}],'/grades':[{code:'A',name:'Fresh'}],
    '/racks':[{code:'M-A1',name:'Main A1',business_location_id:MAIN},{code:'B-A1',name:'Branch A1',business_location_id:BRANCH}],
    '/location-transfers':{rows:[],total:0,limit:100,offset:0}
  };return {ok:true,status:200,headers:new Headers(),text:async()=>JSON.stringify(bodies[path]??[])} as Response;
}));});

describe('production operation screens',()=>{
  test('opening stock is submitted as physical barcode, rack, stage and carried value',async()=>{
    render(<CommercialFoundationView session={session}/>);
    const barcode=await screen.findByLabelText('Opening barcode 1');
    fireEvent.change(barcode,{target:{value:'OPEN-0001'}});
    fireEvent.change(screen.getByLabelText('Opening quality 1'),{target:{value:QUALITY}});
    const selects=screen.getAllByRole('combobox');
    fireEvent.change(screen.getByText('Audited opening stock').closest('section')!.querySelectorAll('select')[0]!,{target:{value:MAIN}});
    const row=barcode.closest('tr')!;const rowInputs=row.querySelectorAll('input');
    fireEvent.change(rowInputs[2]!,{target:{value:'100'}});
    fireEvent.change(row.querySelectorAll('select')[3]!,{target:{value:'M-A1'}});
    fireEvent.change(rowInputs[4]!,{target:{value:'12000'}});
    fireEvent.click(screen.getByRole('button',{name:/post opening stock/i}));
    await waitFor(()=>expect(sent.some(call=>call.path==='/opening-stock')).toBe(true));
    const posted=sent.find(call=>call.path==='/opening-stock')!.body;
    expect(posted.locationId).toBe(MAIN);expect(posted.lines[0]).toEqual(expect.objectContaining({barcode:'OPEN-0001',qualityId:QUALITY,rackCode:'M-A1',greyValue:12000}));
    expect(selects.length).toBeGreaterThan(4);
  });

  test('godown transfer converts scanned lines into one traceable document',async()=>{
    render(<LocationTransferView session={session}/>);
    expect((await screen.findAllByRole('option',{name:/Branch Godown/})).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('To location'),{target:{value:BRANCH}});
    fireEvent.change(screen.getByLabelText('Destination rack'),{target:{value:'B-A1'}});
    fireEvent.change(screen.getByLabelText(/Barcodes/),{target:{value:'PC-001\nPC-002\nPC-001'}});
    fireEvent.click(screen.getByRole('button',{name:/post transfer/i}));
    await waitFor(()=>expect(sent.some(call=>call.path==='/location-transfers')).toBe(true));
    expect(sent.find(call=>call.path==='/location-transfers')!.body.lines).toEqual([
      {barcode:'PC-001',toRack:'B-A1'},{barcode:'PC-002',toRack:'B-A1'}
    ]);
  });

  test('opening stock CSV resolves master codes and remains one reviewed batch',async()=>{
    render(<CommercialFoundationView session={session}/>);
    await screen.findByText('Audited opening stock');
    const section=screen.getByText('Audited opening stock').closest('section')!;
    fireEvent.change(section.querySelectorAll('select')[0]!,{target:{value:MAIN}});
    const csv='barcode,quality_code,grade_code,lot_no,stage,metres,kilograms,rack_code,grey_value,jobwork_value,other_value,process_house_code,issue_challan_no,issue_challan_date,job_rate\nCSV-001,PC,A,LOT-CSV,grey,88,12.5,M-A1,9000,0,50,,,,0';
    const file=new File([csv],'opening.csv',{type:'text/csv'});
    const input=screen.getByText('Load stock CSV').closest('label')!.querySelector('input')!;
    fireEvent.change(input,{target:{files:[file]}});
    await waitFor(()=>expect(screen.getByLabelText('Opening barcode 1')).toHaveValue('CSV-001'));
    fireEvent.click(screen.getByRole('button',{name:/post opening stock/i}));
    await waitFor(()=>expect(sent.some(call=>call.path==='/opening-stock'&&call.body.lines[0].barcode==='CSV-001')).toBe(true));
  });

  test('opening stock CSV carries cloth that is out at a process house',async()=>{
    render(<CommercialFoundationView session={session}/>);
    await screen.findByText('Audited opening stock');
    const section=screen.getByText('Audited opening stock').closest('section')!;
    fireEvent.change(section.querySelectorAll('select')[0]!,{target:{value:MAIN}});
    const header='barcode,quality_code,grade_code,lot_no,stage,metres,kilograms,rack_code,grey_value,jobwork_value,other_value,process_house_code,issue_challan_no,issue_challan_date,job_rate';
    const csv=`${header}\nWIP-001,PC,A,LOT-88,at_process,110,,,27500,0,0,PH-1,THEIR/771,2026-03-18,22`;
    const input=screen.getByText('Load stock CSV').closest('label')!.querySelector('input')!;
    fireEvent.change(input,{target:{files:[new File([csv],'wip.csv',{type:'text/csv'})]}});
    await waitFor(()=>expect(screen.getByLabelText('Opening barcode 1')).toHaveValue('WIP-001'));
    fireEvent.click(screen.getByRole('button',{name:/post opening stock/i}));
    await waitFor(()=>{
      const posted=sent.find(call=>call.path==='/opening-stock');
      expect(posted?.body.lines[0]).toMatchObject({stockKind:'at_process',processHouseId:HOUSE,jobRate:22});
    });
  });

  test('opening stock CSV refuses cloth at a process house with no house named',async()=>{
    render(<CommercialFoundationView session={session}/>);
    await screen.findByText('Audited opening stock');
    const header='barcode,quality_code,grade_code,lot_no,stage,metres,kilograms,rack_code,grey_value,jobwork_value,other_value,process_house_code,issue_challan_no,issue_challan_date,job_rate';
    const csv=`${header}\nWIP-002,PC,A,LOT-88,at_process,110,,,27500,0,0,,,,0`;
    const input=screen.getByText('Load stock CSV').closest('label')!.querySelector('input')!;
    fireEvent.change(input,{target:{files:[new File([csv],'bad.csv',{type:'text/csv'})]}});
    await screen.findByText(/needs process_house_code/i);
    expect(sent.some(call=>call.path==='/opening-stock')).toBe(false);
  });
});
