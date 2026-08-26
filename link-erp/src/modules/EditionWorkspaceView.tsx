import React, {useEffect, useMemo, useState} from 'react';
import {
  AlertTriangle, Calculator, CheckCircle2, Download, Edit3, Paperclip, Pause, Play,
  Save, Settings2, ShieldCheck, SquareCheckBig, XCircle
} from 'lucide-react';
import {ToolbarRibbon} from '../components/ToolbarRibbon';
import {api, ApiError, type Page, type Session} from '../lib/api';
import {useApi} from '../lib/useApi';
import {DocumentAttachments} from '../components/DocumentAttachments';
import {CustomFieldsPanel} from '../components/CustomFieldsPanel';
import {EditionLinesPanel, EditionResourcePanel} from '../components/EditionResourcePanels';

type Edition = 'weaving' | 'dyeing' | 'exports' | 'logistics' | 'garments';
type Field = {
  key: string; label: string; type: 'text' | 'number' | 'date' | 'select' | 'textarea';
  required?: boolean; options?: string[]; unit?: string;
};
type Workflow = {type: string; label: string; fields: Field[]};
type Catalog = {key: Edition; label: string; resourceTypes: string[]; workflows: Workflow[]};
type EditionState = {
  edition: Edition; is_enabled: boolean; config: Record<string, unknown>;
  documents: number; in_progress: number;
};
type Doc = {
  id: string; edition: Edition; doc_type: string; doc_no: string; doc_date: string;
  status: string; payload: Record<string, unknown>; remarks: string;
  party: string | null; location: string | null; parent_document_id?: string | null; parent_document_no?: string | null;
  approval_status?: string; submitted_by?: string | null;
};

const today = () => new Date().toISOString().slice(0, 10);
const input = 'erp-input min-h-11 w-full';
const label = 'mb-1 block text-[11px] font-bold text-slate-700';
const blankValues = (workflow: Workflow) => Object.fromEntries(workflow.fields.map(field => [
  field.key,
  field.type === 'number' ? 0 : field.type === 'date' ? today() : field.options?.[0] ?? ''
]));

export const EditionWorkspaceView: React.FC<{edition: Edition; session: Session}> = ({edition, session}) => {
  const catalog = useApi<Catalog[]>('/editions/catalog');
  const states = useApi<EditionState[]>('/editions');
  const definition = catalog.data?.find(item => item.key === edition);
  const [docType, setDocType] = useState('');
  const docs = useApi<Page<Doc>>(
    docType ? `/editions/${edition}/documents?docType=${docType}&limit=200` : null,
    [edition, docType]
  );
  const referenceDocs = useApi<Page<Doc>>(`/editions/${edition}/documents?limit=500`, [edition]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [docDate, setDocDate] = useState(today());
  const [remarks, setRemarks] = useState('');
  const [parentDocumentId, setParentDocumentId] = useState('');
  const [editing, setEditing] = useState<Doc | null>(null);
  const [notice, setNotice] = useState<{kind: 'ok' | 'error'; text: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [attachmentFor, setAttachmentFor] = useState<Doc | null>(null);
  const [customFor, setCustomFor] = useState<Doc | null>(null);
  const [linesFor, setLinesFor] = useState<Doc | null>(null);
  const [approvalWorkflows, setApprovalWorkflows] = useState<string[]>([]);
  const workflow = definition?.workflows.find(item => item.type === docType);
  const state = states.data?.find(item => item.edition === edition);
  const displayName = definition?.label ?? edition[0]!.toUpperCase() + edition.slice(1);
  const permitted = edition === 'exports'
    ? ['write:sales']
    : edition === 'logistics' ? ['write:store', 'write:sales'] : ['write:store'];
  const canWrite = session.role === 'owner' || permitted.some(permission =>
    session.permissions?.includes(permission));

  useEffect(() => {
    if (definition && !docType) setDocType(definition.workflows[0]?.type ?? '');
  }, [definition, docType]);
  useEffect(() => {
    if (workflow && !editing) setValues(blankValues(workflow));
  }, [workflow, editing]);
  useEffect(()=>{if(state)setApprovalWorkflows(Array.isArray(state.config?.approvalWorkflows)?state.config.approvalWorkflows.filter((value):value is string=>typeof value==='string'):[]);},[state]);

  const run = async (job: () => Promise<unknown>, success: string) => {
    setBusy(true); setNotice(null);
    try {
      await job();
      setNotice({kind: 'ok', text: success});
      docs.reload(); states.reload();
    } catch (error) {
      setNotice({kind: 'error', text: error instanceof ApiError ? error.message : String(error)});
    } finally { setBusy(false); }
  };
  const save = () => run(async () => {
    if (editing) {
      await api.post(`/editions/${edition}/documents/${editing.id}`, {payload: values, remarks});
    } else {
      await api.post(`/editions/${edition}/documents`, {docType, docDate, parentDocumentId: parentDocumentId||null, payload: values, remarks});
    }
    setEditing(null); setRemarks(''); setParentDocumentId('');
    if (workflow) setValues(blankValues(workflow));
  }, editing ? `${editing.doc_no} updated` : `${workflow?.label} draft created`);
  const transition = (row: Doc, status: string) => {
    const reason = status === 'cancelled'
      ? window.prompt(`Why should ${row.doc_no} be cancelled?`)?.trim() ?? '' : '';
    if (status === 'cancelled' && reason.length < 3) return;
    void run(
      () => api.post(`/editions/${edition}/documents/${row.id}/status`, {status, reason}),
      `${row.doc_no} moved to ${status.replace('_', ' ')}`
    );
  };
  const approval = (row: Doc, action: 'submit'|'approved'|'rejected') => {
    const reason=action==='rejected'?window.prompt(`Why should ${row.doc_no} be rejected?`)?.trim()??'':'';
    if(action==='rejected'&&reason.length<3)return;
    const path=action==='submit'?`/editions/${edition}/documents/${row.id}/approval/submit`:`/editions/${edition}/documents/${row.id}/approval/decision`;
    const body=action==='submit'?{}:{decision:action,reason};
    void run(()=>api.post(path,body),`${row.doc_no} approval ${action==='submit'?'submitted':action}`);
  };
  const edit = (row: Doc) => {
    setDocType(row.doc_type); setEditing(row); setDocDate(row.doc_date);
    setValues(row.payload); setRemarks(row.remarks); setParentDocumentId(row.parent_document_id??'');
  };
  const toggle = () => run(
    () => api.post('/editions/config', {
      edition, isEnabled: !state?.is_enabled, config: state?.config ?? {}
    }),
    `${displayName} edition ${state?.is_enabled ? 'paused' : 'enabled'}`
  );
  const requiredMissing = useMemo(() => workflow?.fields.some(field => field.required && (
    values[field.key] === '' || values[field.key] === null || values[field.key] === undefined
  )) ?? true, [workflow, values]);

  return <main className="flex h-full flex-col overflow-hidden bg-[#ecf1f7] text-xs text-slate-800">
    <ToolbarRibbon
      title={`${displayName} Edition`}
      onSave={canWrite ? save : undefined}
      onExport={() => void api.download(
        `/editions/${edition}/documents?docType=${docType}&format=csv`, `${edition}-${docType}.csv`
      )}
      onPrint={() => window.print()}
    />
    {notice && <div role={notice.kind === 'error' ? 'alert' : 'status'} className={`flex items-center gap-2 px-4 py-2 font-semibold text-white ${notice.kind === 'error' ? 'bg-red-700' : 'bg-emerald-700'}`}>
      {notice.kind === 'error' ? <AlertTriangle className="h-4 w-4"/> : <CheckCircle2 className="h-4 w-4"/>}
      {notice.text}
    </div>}
    <header className="flex flex-wrap items-center gap-3 border-b bg-white px-4 py-3">
      <div>
        <h1 className="text-sm font-bold text-blue-950">{displayName} operations</h1>
        <p className="text-slate-600">Shared accounts, users, audit, reports, evidence and integrations; edition-specific operational controls.</p>
      </div>
      {state ? <>
        <span className={`ml-auto rounded border px-3 py-1 font-bold ${state.is_enabled ? 'border-emerald-400 bg-emerald-50 text-emerald-800' : 'border-red-400 bg-red-50 text-red-800'}`}>{state.is_enabled ? 'ENABLED' : 'PAUSED'}</span>
        <span>{state.documents} documents · {state.in_progress} active</span>
        {session.role === 'owner' && <button className="erp-btn min-h-11" onClick={() => void toggle()}>
          {state.is_enabled ? <Pause className="h-4 w-4"/> : <Play className="h-4 w-4"/>}
          {state.is_enabled ? 'Pause edition' : 'Enable edition'}
        </button>}
      </> : <span className="ml-auto text-slate-500">Loading edition controls…</span>}
    </header>
    {session.role==='owner'&&state&&<details className="border-b bg-violet-50 px-4 py-2"><summary className="min-h-11 cursor-pointer py-3 font-bold text-violet-950">Maker-checker approval controls · {approvalWorkflows.length} workflows require independent approval</summary><div className="flex flex-wrap items-center gap-2 pb-3">{definition?.workflows.map(item=><label className="flex min-h-11 items-center gap-2 rounded border bg-white px-3" key={item.type}><input type="checkbox" checked={approvalWorkflows.includes(item.type)} onChange={event=>setApprovalWorkflows(current=>event.target.checked?[...current,item.type]:current.filter(value=>value!==item.type))}/>{item.label}</label>)}<button className="erp-btn erp-btn-primary min-h-11" onClick={()=>void run(()=>api.post('/editions/config',{edition,isEnabled:state.is_enabled,config:{...state.config,approvalWorkflows}}),'Edition approval controls saved')}><ShieldCheck className="h-4 w-4"/>Save approval controls</button></div></details>}
    <div className="flex-1 overflow-auto p-4">
      <div className="mx-auto grid max-w-[1500px] gap-4 xl:grid-cols-[460px_1fr]">
        <section className="rounded border bg-white p-4">
          <div className="flex items-center gap-2">
            <h2 className="font-bold text-blue-950">{editing ? `Edit ${editing.doc_no}` : 'New edition document'}</h2>
            {editing && <button className="erp-btn ml-auto" onClick={() => {setEditing(null); setRemarks('');}}>
              <XCircle className="h-4 w-4"/>Stop editing
            </button>}
          </div>
          {!canWrite && <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 font-semibold text-amber-900">Read-only access: this permission profile can view and export this edition.</p>}
          <fieldset disabled={!canWrite}>
            <label className="mt-3 block"><span className={label}>Workflow</span>
              <select aria-label="Edition workflow" disabled={Boolean(editing)} className={input} value={docType} onChange={event => {setEditing(null); setDocType(event.target.value);}}>
                {definition?.workflows.map(item => <option key={item.type} value={item.type}>{item.label}</option>)}
              </select>
            </label>
            <label className="mt-3 block"><span className={label}>Document date</span>
              <input aria-label="Edition document date" disabled={Boolean(editing)} type="date" className={input} value={docDate} onChange={event => setDocDate(event.target.value)}/>
            </label>
            <label className="mt-3 block"><span className={label}>Linked parent document</span>
              <select aria-label="Linked edition document" disabled={Boolean(editing)} className={input} value={parentDocumentId} onChange={event=>setParentDocumentId(event.target.value)}><option value="">No parent document</option>{(referenceDocs.data?.rows??[]).filter(row=>row.id!==editing?.id).map(row=><option value={row.id} key={row.id}>{row.doc_no} · {row.doc_type.replaceAll('_',' ')}</option>)}</select>
            </label>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {workflow?.fields.map(field => <label className={field.type === 'textarea' ? 'md:col-span-2' : ''} key={field.key}>
                <span className={label}>{field.label}{field.required ? ' *' : ''}{field.unit ? ` (${field.unit})` : ''}</span>
                {field.type === 'select' ? <select aria-label={field.label} className={input} value={String(values[field.key] ?? '')} onChange={event => setValues({...values, [field.key]: event.target.value})}>
                  {field.options?.map(option => <option key={option}>{option}</option>)}
                </select> : field.type === 'textarea' ? <textarea aria-label={field.label} className={`${input} min-h-24`} value={String(values[field.key] ?? '')} onChange={event => setValues({...values, [field.key]: event.target.value})}/>
                  : <input aria-label={field.label} className={input} type={field.type} step={field.type === 'number' ? 'any' : undefined} value={String(values[field.key] ?? '')} onChange={event => setValues({...values, [field.key]: field.type === 'number' ? Number(event.target.value) : event.target.value})}/>} 
              </label>)}
            </div>
            <label className="mt-3 block"><span className={label}>Remarks</span>
              <textarea className={`${input} min-h-20`} value={remarks} onChange={event => setRemarks(event.target.value)}/>
            </label>
            <button disabled={busy || !state?.is_enabled || requiredMissing} className="erp-btn erp-btn-primary mt-3 min-h-11" onClick={() => void save()}>
              <Save className="h-4 w-4"/>{editing ? 'Save changes' : 'Create draft'}
            </button>
          </fieldset>
        </section>
        <section className="overflow-hidden rounded border bg-white">
          <div className="flex items-center gap-2 border-b bg-slate-50 p-3">
            <strong className="text-blue-950">{workflow?.label} register</strong>
            <button className="erp-btn ml-auto min-h-11" onClick={() => void api.download(
              `/editions/${edition}/documents?docType=${docType}&format=csv`, `${edition}-${docType}.csv`
            )}><Download className="h-4 w-4"/>Export</button>
          </div>
          <div className="overflow-auto" tabIndex={0} aria-label={`${workflow?.label ?? displayName} register table`}>
            <table className="w-full min-w-[850px]">
              <thead><tr><th className="p-2 text-left">Document</th><th className="p-2">Date</th><th className="p-2 text-left">Operational facts</th><th className="p-2">Status</th><th className="p-2">Controls</th></tr></thead>
              <tbody>
                {(docs.data?.rows ?? []).map(row => <tr className="border-t" key={row.id}>
                  <td className="p-2 font-mono font-bold text-blue-900">{row.doc_no}</td>
                  <td className="p-2 text-center">{row.doc_date}</td>
                  <td className="p-2">{Object.entries(row.payload).slice(0, 4).map(([key, value]) => <span className="mr-3 inline-block" key={key}><b>{workflow?.fields.find(field => field.key === key)?.label ?? key}:</b> {String(value)}</span>)}</td>
                  <td className="p-2 text-center font-bold uppercase">{row.status.replace('_', ' ')}{row.approval_status&&row.approval_status!=='not_required'&&<span className="mt-1 block text-[10px] text-violet-800">Approval: {row.approval_status.replace('_',' ')}</span>}</td>
                  <td className="flex flex-wrap justify-center gap-1 p-2">
                    {canWrite && ['draft', 'in_progress'].includes(row.status) && <button aria-label={`Edit ${row.doc_no}`} className="erp-btn min-h-11" onClick={() => edit(row)}><Edit3 className="h-4 w-4"/></button>}
                    {canWrite && <button aria-label={`Custom fields for ${row.doc_no}`} className="erp-btn min-h-11" onClick={() => setCustomFor(row)}><Settings2 className="h-4 w-4 text-violet-700"/></button>}
                    <button aria-label={`Attachments for ${row.doc_no}`} className="erp-btn min-h-11" onClick={() => setAttachmentFor(row)}><Paperclip className="h-4 w-4 text-blue-700"/></button>
                    <button aria-label={`Materials and costing for ${row.doc_no}`} className="erp-btn min-h-11" onClick={() => setLinesFor(row)}><Calculator className="h-4 w-4 text-amber-700"/></button>
                    {canWrite && row.status === 'draft' && <button className="erp-btn min-h-11" onClick={() => transition(row, 'in_progress')}><Play className="h-4 w-4"/>Start</button>}
                    {canWrite && row.status === 'in_progress' && <><button className="erp-btn min-h-11" onClick={() => transition(row, 'held')}><Pause className="h-4 w-4"/>Hold</button>{['not_required','approved',undefined].includes(row.approval_status)&&<button className="erp-btn min-h-11" onClick={() => transition(row, 'completed')}><SquareCheckBig className="h-4 w-4"/>Complete</button>}</>}
                    {canWrite&&row.status==='in_progress'&&['not_submitted','rejected'].includes(row.approval_status??'')&&<button className="erp-btn min-h-11" onClick={()=>approval(row,'submit')}><ShieldCheck className="h-4 w-4"/>Submit approval</button>}
                    {session.role==='owner'&&row.approval_status==='pending'&&row.submitted_by!==session.userId&&<><button className="erp-btn min-h-11 text-emerald-800" onClick={()=>approval(row,'approved')}><ShieldCheck className="h-4 w-4"/>Approve</button><button className="erp-btn min-h-11 text-red-700" onClick={()=>approval(row,'rejected')}><XCircle className="h-4 w-4"/>Reject</button></>}
                    {canWrite && row.status === 'held' && <button className="erp-btn min-h-11" onClick={() => transition(row, 'in_progress')}><Play className="h-4 w-4"/>Resume</button>}
                    {canWrite && !['completed', 'cancelled'].includes(row.status) && <button className="erp-btn min-h-11 text-red-700" onClick={() => transition(row, 'cancelled')}><XCircle className="h-4 w-4"/>Cancel</button>}
                  </td>
                </tr>)}
                {!docs.loading && (docs.data?.rows ?? []).length === 0 && <tr><td colSpan={5} className="p-8 text-center text-slate-500">No {workflow?.label.toLowerCase()} documents yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <EditionResourcePanel edition={edition} resourceTypes={definition?.resourceTypes??[]} canWrite={canWrite} enabled={Boolean(state?.is_enabled)}/>
      </div>
    </div>
    {attachmentFor && <DocumentAttachments docType="edition_document" docId={attachmentFor.id} label={attachmentFor.doc_no} onClose={() => setAttachmentFor(null)}/>} 
    {customFor && <CustomFieldsPanel entityType="edition_document" entityId={customFor.id} label={customFor.doc_no} onClose={() => setCustomFor(null)}/>} 
    {linesFor && <EditionLinesPanel edition={edition} document={linesFor} canWrite={canWrite} onClose={() => setLinesFor(null)}/>} 
  </main>;
};
