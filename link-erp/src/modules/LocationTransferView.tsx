import React,{useMemo,useState} from 'react';
import {AlertTriangle,ArrowRightLeft,CheckCircle2,Paperclip,RotateCcw,Settings2} from 'lucide-react';
import {api,ApiError,type BusinessLocation,type Page,type Session} from '../lib/api';
import {useApi} from '../lib/useApi';
import {ToolbarRibbon} from '../components/ToolbarRibbon';
import {DocumentAttachments} from '../components/DocumentAttachments';
import {CustomFieldsPanel} from '../components/CustomFieldsPanel';

interface Rack{code:string;name:string;business_location_id:string}
interface Transfer{id:string;transfer_no:string;transfer_date:string;status:string;from_code:string;from_location:string;to_code:string;to_location:string;pieces:number;quantity:number;remarks:string;cancellation_reason:string|null}
const field='erp-input min-h-11 w-full';const label='block text-[11px] font-bold text-slate-700 mb-1';

export const LocationTransferView:React.FC<{session:Session}>=({session})=>{
  const locations=useApi<BusinessLocation[]>('/locations');const racks=useApi<Rack[]>('/racks?limit=500');
  const transfers=useApi<Page<Transfer>>('/location-transfers?limit=100');
  const [form,setForm]=useState({transferDate:new Date().toISOString().slice(0,10),fromLocationId:session.activeLocation?.id??'',toLocationId:'',toRack:'',barcodes:'',remarks:''});
  const [notice,setNotice]=useState<{kind:'ok'|'error';text:string}|null>(null);const [busy,setBusy]=useState(false);
  const [attachmentFor,setAttachmentFor]=useState<Transfer|null>(null);
  const [customFor,setCustomFor]=useState<Transfer|null>(null);
  const barcodeList=useMemo(()=>Array.from(new Set(form.barcodes.split(/[\s,]+/).map(value=>value.trim()).filter(Boolean))),[form.barcodes]);
  const destinationRacks=(racks.data??[]).filter(row=>row.business_location_id===form.toLocationId);
  const run=async(work:()=>Promise<unknown>,success:string)=>{setBusy(true);setNotice(null);try{await work();setNotice({kind:'ok',text:success});transfers.reload();}
    catch(error){setNotice({kind:'error',text:error instanceof ApiError?error.message:String(error)});}finally{setBusy(false);}};
  const submit=()=>{if(!form.fromLocationId||!form.toLocationId||barcodeList.length===0){setNotice({kind:'error',text:'Choose both locations and scan at least one barcode.'});return Promise.resolve();}
    return run(async()=>{await api.post('/location-transfers',{transferDate:form.transferDate,fromLocationId:form.fromLocationId,toLocationId:form.toLocationId,remarks:form.remarks,
    lines:barcodeList.map(barcode=>({barcode,toRack:form.toRack||null}))});setForm({...form,barcodes:'',remarks:''});},`${barcodeList.length} piece(s) transferred with audit history`);
  };
  const cancel=(row:Transfer)=>{const reason=window.prompt(`Why should ${row.transfer_no} be reversed?`,'Transfer entered in error')?.trim();if(!reason)return;void run(()=>api.post(`/location-transfers/${row.id}/cancel`,{reason}),`${row.transfer_no} reversed`);};
  return <main className="flex h-full flex-col overflow-auto bg-[#ecf1f7] text-xs text-slate-800"><ToolbarRibbon title="Godown Stock Transfer" onSave={submit} onPrint={()=>window.print()}/>
    {notice&&<div role={notice.kind==='error'?'alert':'status'} className={`flex items-center gap-2 px-4 py-2 font-semibold text-white ${notice.kind==='error'?'bg-red-700':'bg-emerald-700'}`}>{notice.kind==='error'?<AlertTriangle className="h-4 w-4"/>:<CheckCircle2 className="h-4 w-4"/>}{notice.text}</div>}
    <div className="mx-auto grid w-full max-w-7xl gap-4 p-4"><section className="rounded border border-[#b8c9dd] bg-white p-4"><div className="flex items-center gap-2"><ArrowRightLeft className="h-5 w-5 text-blue-900"/><div><h1 className="text-sm font-bold text-blue-950">Move physical pieces between business locations</h1><p className="text-slate-600">Scan one barcode per line. Quantity, stage and value do not change; only godown and rack custody move.</p></div><strong className="ml-auto">{barcodeList.length} scanned</strong></div>
      <div className="mt-4 grid gap-3 md:grid-cols-4"><label><span className={label}>Transfer date</span><input className={field} type="date" value={form.transferDate} onChange={e=>setForm({...form,transferDate:e.target.value})}/></label>
        <label><span className={label}>From location</span><select className={field} value={form.fromLocationId} onChange={e=>setForm({...form,fromLocationId:e.target.value})}><option value="">Select</option>{(locations.data??[]).filter(row=>row.is_active).map(row=><option key={row.id} value={row.id}>{row.code} — {row.name}</option>)}</select></label>
        <label><span className={label}>To location</span><select className={field} value={form.toLocationId} onChange={e=>setForm({...form,toLocationId:e.target.value,toRack:''})}><option value="">Select</option>{(locations.data??[]).filter(row=>row.is_active&&row.id!==form.fromLocationId).map(row=><option key={row.id} value={row.id}>{row.code} — {row.name}</option>)}</select></label>
        <label><span className={label}>Destination rack</span><select className={field} value={form.toRack} onChange={e=>setForm({...form,toRack:e.target.value})}><option value="">Unracked</option>{destinationRacks.map(row=><option key={row.code} value={row.code}>{row.code} — {row.name}</option>)}</select></label>
        <label className="md:col-span-3"><span className={label}>Barcodes — scan or paste one per line</span><textarea className={`${field} min-h-36 font-mono`} value={form.barcodes} onChange={e=>setForm({...form,barcodes:e.target.value})}/></label>
        <label><span className={label}>Remarks</span><textarea className={`${field} min-h-36`} value={form.remarks} onChange={e=>setForm({...form,remarks:e.target.value})}/></label></div>
      <button disabled={busy||!form.fromLocationId||!form.toLocationId||barcodeList.length===0} className="erp-btn erp-btn-primary mt-3 min-h-11" onClick={()=>void submit()}><ArrowRightLeft className="h-4 w-4"/>Post transfer</button>
    </section>
    <section className="overflow-hidden rounded border border-[#b8c9dd] bg-white"><div className="border-b bg-slate-50 px-4 py-2 font-bold text-blue-950">Recent transfers</div><div className="overflow-x-auto"><table className="w-full min-w-[820px]"><thead><tr><th className="p-2 text-left">Transfer</th><th className="p-2">Date</th><th className="p-2 text-left">From</th><th className="p-2 text-left">To</th><th className="p-2 text-right">Pieces</th><th className="p-2 text-right">Metres</th><th className="p-2">Status</th><th></th></tr></thead><tbody>
      {(transfers.data?.rows??[]).map(row=><tr className="border-t" key={row.id}><td className="p-2 font-mono font-bold">{row.transfer_no}</td><td className="p-2 text-center">{row.transfer_date}</td><td className="p-2">{row.from_code} — {row.from_location}</td><td className="p-2">{row.to_code} — {row.to_location}</td><td className="p-2 text-right">{row.pieces}</td><td className="p-2 text-right font-mono">{Number(row.quantity).toFixed(2)}</td><td className="p-2 text-center capitalize">{row.status}</td><td className="flex gap-1 p-2"><button aria-label={`Custom fields for ${row.transfer_no}`} className="erp-btn min-h-11" onClick={()=>setCustomFor(row)}><Settings2 className="h-4 w-4 text-violet-700"/></button><button aria-label={`Attachments for ${row.transfer_no}`} className="erp-btn min-h-11" onClick={()=>setAttachmentFor(row)}><Paperclip className="h-4 w-4 text-blue-700"/></button><button disabled={busy||row.status==='cancelled'} className="erp-btn min-h-11" onClick={()=>cancel(row)}><RotateCcw className="h-4 w-4"/>Reverse</button></td></tr>)}
      {!transfers.loading&&(transfers.data?.rows??[]).length===0&&<tr><td className="p-5 text-center text-slate-500" colSpan={8}>No location transfers yet.</td></tr>}</tbody></table></div></section></div>
    {attachmentFor&&<DocumentAttachments docType="location_transfer" docId={attachmentFor.id} label={attachmentFor.transfer_no} onClose={()=>setAttachmentFor(null)}/>}
    {customFor&&<CustomFieldsPanel entityType="location_transfer" entityId={customFor.id} label={customFor.transfer_no} onClose={()=>setCustomFor(null)}/>}
  </main>;
};
