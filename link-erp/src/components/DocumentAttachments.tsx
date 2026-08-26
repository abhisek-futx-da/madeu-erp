import React,{useState} from 'react';
import {AlertTriangle,FilePlus2,Paperclip,Trash2,X} from 'lucide-react';
import {api,ApiError} from '../lib/api';
import {useApi} from '../lib/useApi';

interface Attachment{id:string;file_name:string;content_type:string;byte_size:number;sha256:string;note:string;status:string;created_at:string;created_by_name:string;removed_at:string|null;removal_reason:string|null}

const fileBase64=(file:File)=>new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(reader.error);reader.onload=()=>resolve(String(reader.result).split(',',2)[1]??'');reader.readAsDataURL(file);});

export const DocumentAttachments:React.FC<{
  docType:string;docId:string;label:string;onClose:()=>void
}>=({docType,docId,label,onClose})=>{
  const list=useApi<Attachment[]>(`/attachments?docType=${encodeURIComponent(docType)}&docId=${docId}`);
  const [file,setFile]=useState<File|null>(null);const[note,setNote]=useState('');
  const[busy,setBusy]=useState(false);const[error,setError]=useState('');
  const upload=async()=>{if(!file)return;setBusy(true);setError('');try{
    if(file.size>5*1024*1024)throw new Error('File exceeds 5 MB');
    if(!['application/pdf','image/jpeg','image/png'].includes(file.type))throw new Error('Use a PDF, JPEG or PNG file');
    await api.post('/attachments',{docType,docId,fileName:file.name,contentType:file.type,dataBase64:await fileBase64(file),note});
    setFile(null);setNote('');list.reload();
  }catch(e){setError(e instanceof ApiError?e.message:e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const remove=async(row:Attachment)=>{const reason=window.prompt(`Why should ${row.file_name} be removed from active evidence?`)?.trim();if(!reason)return;setBusy(true);setError('');try{await api.post(`/attachments/${row.id}/remove`,{reason});list.reload();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-label={`Attachments for ${label}`}><section className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded border bg-white shadow-xl">
    <header className="flex items-center gap-2 bg-blue-900 px-4 py-3 text-white"><Paperclip className="h-4 w-4"/><strong>Document evidence — {label}</strong><button className="ml-auto min-h-11 min-w-11" aria-label="Close attachments" onClick={onClose}><X className="mx-auto h-5 w-5"/></button></header>
    {error&&<div role="alert" className="flex items-center gap-2 bg-red-700 px-4 py-2 font-semibold text-white"><AlertTriangle className="h-4 w-4"/>{error}</div>}
    <div className="grid gap-3 border-b bg-slate-50 p-4 md:grid-cols-[1fr_1fr_auto]"><label className="erp-btn min-h-11 cursor-pointer justify-center"><FilePlus2 className="h-4 w-4"/>{file?.name??'Choose PDF/JPEG/PNG'}<input className="sr-only" type="file" accept="application/pdf,image/jpeg,image/png" onChange={e=>setFile(e.target.files?.[0]??null)}/></label><label><span className="sr-only">Attachment note</span><input className="erp-input min-h-11 w-full" placeholder="Evidence note (optional)" value={note} onChange={e=>setNote(e.target.value)}/></label><button className="erp-btn erp-btn-primary min-h-11" disabled={busy||!file} onClick={()=>void upload()}>Upload evidence</button></div>
    <div className="overflow-auto"><table className="w-full"><thead className="sticky top-0 bg-slate-100"><tr><th className="p-2 text-left">File</th><th className="p-2 text-left">Evidence</th><th className="p-2 text-left">Added</th><th className="p-2">Status</th><th></th></tr></thead><tbody>
      {(list.data??[]).map(row=><tr key={row.id} className="border-t"><td className="p-2"><button disabled={row.status!=='active'} className="font-semibold text-blue-800 disabled:text-slate-500" onClick={()=>void api.download(`/attachments/${row.id}/download`,row.file_name)}>{row.file_name}</button><span className="block text-[10px] text-slate-500">{(row.byte_size/1024).toFixed(1)} KB · SHA {row.sha256.slice(0,12)}…</span></td><td className="p-2">{row.note||'—'}{row.removal_reason&&<span className="block text-red-700">Removed: {row.removal_reason}</span>}</td><td className="p-2">{row.created_by_name}<span className="block text-[10px]">{new Date(row.created_at).toLocaleString('en-GB')}</span></td><td className="p-2 text-center font-bold uppercase">{row.status}</td><td className="p-2"><button aria-label={`Remove ${row.file_name}`} disabled={busy||row.status!=='active'} className="erp-btn min-h-11" onClick={()=>void remove(row)}><Trash2 className="h-4 w-4 text-red-700"/></button></td></tr>)}
      {!list.loading&&(list.data??[]).length===0&&<tr><td colSpan={5} className="p-6 text-center text-slate-500">No evidence files attached.</td></tr>}
    </tbody></table></div>
  </section></div>;
};
