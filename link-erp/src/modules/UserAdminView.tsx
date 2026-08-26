import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, ShieldCheck, UserPlus } from 'lucide-react';
import { ToolbarRibbon } from '../components/ToolbarRibbon';
import { api, type Session } from '../lib/api';
import { useApi } from '../lib/useApi';

type Role = 'owner' | 'accounts' | 'purchase' | 'sales' | 'store' | 'viewer';
const roles: Role[] = ['owner', 'accounts', 'purchase', 'sales', 'store', 'viewer'];

interface TenantUser {
  id: string; email: string; fullName: string; role: Role; isActive: boolean; createdAt: string; mfaEnabled: boolean;
  permissionProfileId:string;permissionProfileName:string;activeLocationId:string;activeLocationName:string;
}
interface PermissionProfile{id:string;code:string;name:string;base_role:Role;permissions:string[];is_system:boolean;is_active:boolean;members:number}
interface Location{id:string;code:string;name:string;is_default:boolean;is_active:boolean}
interface AuditEntry {
  id: number; event: string; details: Record<string, unknown>; occurredAt: string;
  actorName: string | null; targetName: string | null;
}

const blank = { email: '', fullName: '', role: 'viewer' as Role, password: '',permissionProfileId:'',activeLocationId:'' };
const permissionOptions=['write:masters','write:purchase','write:store','write:sales','write:accounts','write:owner'];
const passwordHint = '12+ characters, including uppercase, lowercase, and a number.';

/** Owner-only staff management.  It never displays passwords or creates a
 * second owner by accidentally reusing another company’s account. */
export const UserAdminView: React.FC<{ session: Session }> = ({ session }) => {
  const users = useApi<TenantUser[]>(session.role === 'owner' ? '/users' : null);
  const audit = useApi<AuditEntry[]>(session.role === 'owner' ? '/users/audit' : null);
  const profiles=useApi<PermissionProfile[]>(session.role==='owner'?'/permission-profiles':null);
  const locations=useApi<Location[]>(session.role==='owner'?'/locations':null);
  const [create, setCreate] = useState(blank);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ role: Role; isActive: boolean;permissionProfileId:string;activeLocationId:string } | null>(null);
  const [newProfile,setNewProfile]=useState({code:'',name:'',baseRole:'viewer' as Role,permissions:[] as string[],isActive:true});
  const [resetPassword, setResetPassword] = useState('');
  const [mfaResetReason, setMfaResetReason] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = useMemo(
    () => (users.data ?? []).find(u => u.id === selectedId) ?? null,
    [users.data, selectedId]
  );
  useEffect(()=>{
    if(!create.permissionProfileId&&profiles.data?.length){
      const profile=profiles.data.find(row=>row.base_role==='viewer'&&row.is_system&&row.is_active)??profiles.data.find(row=>row.is_active);
      const location=locations.data?.find(row=>row.is_default&&row.is_active)??locations.data?.find(row=>row.is_active);
      if(profile)setCreate(current=>({...current,role:profile.base_role,permissionProfileId:profile.id,activeLocationId:current.activeLocationId||location?.id||''}));
    }
  },[create.permissionProfileId,locations.data,profiles.data]);

  if (session.role !== 'owner') {
    return <div className="p-5 text-sm text-red-800">Only an owner can manage company access.</div>;
  }

  const act = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await work();
      setNotice(success);
      users.reload(); audit.reload();profiles.reload();locations.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const addUser = () => act(async () => {
    if (!create.email || !create.fullName || !create.password) throw new Error('Name, email, role, and temporary password are required.');
    await api.post('/users', create);
    setCreate(blank);
  }, 'User created. Give the temporary password privately and ask the worker to change it on first sign-in.');

  const saveUser = () => {
    if (!selected) return;
    return act(async () => {
      await api.post(`/users/${selected.id}`, {
        role: edit?.role ?? selected.role, isActive: edit?.isActive ?? selected.isActive,
        permissionProfileId:edit?.permissionProfileId??selected.permissionProfileId,
        activeLocationId:edit?.activeLocationId??selected.activeLocationId,
        ...(resetPassword ? { resetPassword } : {})
      });
      setResetPassword('');
    }, 'Access updated and recorded in the access audit.');
  };

  const resetMfa = () => {
    if (!selected) return;
    return act(async () => {
      await api.post(`/users/${selected.id}/mfa-reset`, {
        currentPassword: ownerPassword, reason: mfaResetReason
      });
      setOwnerPassword(''); setMfaResetReason('');
    }, 'Lost-device MFA reset recorded. The worker was signed out everywhere and must enrol again.');
  };

  return (
    <div className="flex h-full flex-col overflow-auto bg-[#ecf1f7] text-slate-800 text-xs">
      <ToolbarRibbon title="People & Access" onSave={saveUser} onNew={() => {
        setSelectedId(null); setEdit(null); setResetPassword(''); setNotice(null); setError(null);
      }} />
      {(notice || error || users.error || audit.error) && (
        <div className={`px-4 py-2 flex items-center gap-2 font-semibold ${
          error || users.error || audit.error ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
        }`}>
          {error || users.error || audit.error ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          <span>{error ?? users.error ?? audit.error ?? notice}</span>
        </div>
      )}
      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.75fr)]">
        <section className="overflow-hidden rounded border border-[#b8c9dd] bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
            <ShieldCheck className="h-4 w-4 text-blue-800" />
            <h1 className="font-bold text-slate-900">Company users</h1>
            <span className="ml-auto text-slate-500">Disabled users cannot sign in to this company.</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px]">
              <thead className="bg-slate-100 text-left"><tr>
                <th className="px-3 py-2">Name</th><th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Profile</th><th className="px-3 py-2">Location</th><th className="px-3 py-2">MFA</th><th className="px-3 py-2">Access</th>
              </tr></thead>
              <tbody>
                {(users.data ?? []).map(user => (
                  <tr key={user.id} onClick={() => {
                    setSelectedId(user.id); setEdit({ role: user.role, isActive: user.isActive,permissionProfileId:user.permissionProfileId,activeLocationId:user.activeLocationId });
                    setResetPassword(''); setNotice(null);
                  }}
                      className={`cursor-pointer border-t border-slate-100 hover:bg-blue-50 ${selectedId === user.id ? 'bg-blue-100' : ''}`}>
                    <td className="px-3 py-2 font-medium">{user.fullName}</td>
                    <td className="px-3 py-2">{user.email}</td>
                    <td className="px-3 py-2"><strong>{user.permissionProfileName}</strong><span className="block capitalize text-slate-500">{user.role}</span></td>
                    <td className="px-3 py-2">{user.activeLocationName}</td>
                    <td className="px-3 py-2">{user.mfaEnabled ? <span className="text-emerald-800 font-semibold">Enabled</span> : <span className={user.role === 'owner' || user.role === 'accounts' ? 'text-red-800 font-bold' : 'text-slate-600'}>Not enabled</span>}</td>
                    <td className="px-3 py-2">{user.isActive ? <span className="text-emerald-700">Active</span> : <span className="text-red-700">Disabled</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {users.loading && <p className="p-4 text-slate-500">Loading users…</p>}
        </section>

        <section className="rounded border border-[#b8c9dd] bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2"><UserPlus className="h-4 w-4 text-blue-800" /><h2 className="font-bold">Add a worker</h2></div>
          <div className="mt-3 grid gap-2">
            <label className="erp-label">Full name<input className="erp-input mt-1 w-full" value={create.fullName} onChange={e => setCreate({ ...create, fullName: e.target.value })} /></label>
            <label className="erp-label">Email<input className="erp-input mt-1 w-full" type="email" autoComplete="off" value={create.email} onChange={e => setCreate({ ...create, email: e.target.value })} /></label>
            <label className="erp-label">Permission profile<select className="erp-input mt-1 w-full" value={create.permissionProfileId} onChange={e=>{const profile=profiles.data?.find(row=>row.id===e.target.value);setCreate({...create,permissionProfileId:e.target.value,role:profile?.base_role??create.role});}}><option value="">Select</option>{profiles.data?.filter(row=>row.is_active).map(row=><option key={row.id} value={row.id}>{row.name} — {row.base_role}</option>)}</select></label>
            <label className="erp-label">Active location<select className="erp-input mt-1 w-full" value={create.activeLocationId} onChange={e=>setCreate({...create,activeLocationId:e.target.value})}><option value="">Default location</option>{locations.data?.filter(row=>row.is_active).map(row=><option key={row.id} value={row.id}>{row.code} — {row.name}</option>)}</select></label>
            <label className="erp-label">Temporary password<input className="erp-input mt-1 w-full" type="password" autoComplete="new-password" value={create.password} onChange={e => setCreate({ ...create, password: e.target.value })} /></label>
            <p className="text-slate-500">{passwordHint}</p>
            <button type="button" disabled={busy} onClick={addUser} className="erp-btn erp-btn-primary justify-center disabled:opacity-50">Add worker</button>
          </div>
        </section>

        {selected && <section className="rounded border border-[#b8c9dd] bg-white p-4 shadow-sm xl:col-span-2">
          <div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-blue-800" /><h2 className="font-bold">Edit {selected.fullName}</h2></div>
          <div className="mt-3 grid gap-3 md:grid-cols-4">
            <label className="erp-label">Permission profile<select className="erp-input mt-1 w-full" value={edit?.permissionProfileId??selected.permissionProfileId} onChange={e=>{const profile=profiles.data?.find(row=>row.id===e.target.value);setEdit({role:profile?.base_role??selected.role,isActive:edit?.isActive??selected.isActive,permissionProfileId:e.target.value,activeLocationId:edit?.activeLocationId??selected.activeLocationId});}}>{profiles.data?.filter(row=>row.is_active).map(row=><option key={row.id} value={row.id}>{row.name} — {row.base_role}</option>)}</select></label>
            <label className="erp-label">Active location<select className="erp-input mt-1 w-full" value={edit?.activeLocationId??selected.activeLocationId} onChange={e=>setEdit({role:edit?.role??selected.role,isActive:edit?.isActive??selected.isActive,permissionProfileId:edit?.permissionProfileId??selected.permissionProfileId,activeLocationId:e.target.value})}>{locations.data?.filter(row=>row.is_active).map(row=><option key={row.id} value={row.id}>{row.code} — {row.name}</option>)}</select></label>
            <label className="erp-label flex flex-col justify-end">Access
              <select className="erp-input mt-1 w-full" value={(edit?.isActive ?? selected.isActive) ? 'active' : 'disabled'} onChange={e => {
                setEdit({ role: edit?.role ?? selected.role, isActive: e.target.value === 'active',permissionProfileId:edit?.permissionProfileId??selected.permissionProfileId,activeLocationId:edit?.activeLocationId??selected.activeLocationId });
              }}><option value="active">Active</option><option value="disabled">Disabled</option></select>
            </label>
            <label className="erp-label">Reset password (optional)<input className="erp-input mt-1 w-full" type="password" autoComplete="new-password" value={resetPassword} onChange={e => setResetPassword(e.target.value)} /></label>
          </div>
          <p className="mt-2 text-slate-500">Promote a replacement owner before disabling or demoting the last active owner. {passwordHint}</p>
          <button type="button" disabled={busy} onClick={saveUser} className="erp-btn erp-btn-primary mt-3 disabled:opacity-50">Save access change</button>
          {selected.mfaEnabled && selected.id !== session.userId && <div className="mt-4 border-t border-red-200 pt-4">
            <h3 className="font-bold text-red-900">Lost authenticator recovery</h3>
            <p className="mt-1 text-slate-600">This destroys the worker's MFA secret and recovery codes, signs them out everywhere, and creates an access-audit event.</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="erp-label">Reason (minimum 10 characters)<input className="erp-input mt-1 w-full" value={mfaResetReason} onChange={e => setMfaResetReason(e.target.value)} /></label>
              <label className="erp-label">Your owner password<input className="erp-input mt-1 w-full" type="password" autoComplete="current-password" value={ownerPassword} onChange={e => setOwnerPassword(e.target.value)} /></label>
            </div>
            <button type="button" disabled={busy || mfaResetReason.trim().length < 10 || !ownerPassword} onClick={resetMfa} className="erp-btn mt-3 border-red-400 text-red-800 disabled:opacity-50">Reset worker MFA and revoke sessions</button>
          </div>}
        </section>}

        <section className="rounded border border-[#b8c9dd] bg-white p-4 shadow-sm xl:col-span-2">
          <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-blue-800"/><div><h2 className="font-bold">Permission profiles</h2><p className="text-slate-500">Profiles decide what a worker can actually write. The base role remains the approval and responsibility label.</p></div></div>
          <div className="mt-3 flex flex-wrap gap-2">{profiles.data?.map(profile=><span key={profile.id} className="rounded border bg-slate-50 px-3 py-2"><strong>{profile.name}</strong> · {profile.base_role} · {profile.members} member(s){profile.is_system?' · system':''}</span>)}</div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <label className="erp-label">Code<input className="erp-input mt-1 w-full" value={newProfile.code} onChange={e=>setNewProfile({...newProfile,code:e.target.value.toUpperCase()})}/></label>
            <label className="erp-label">Profile name<input className="erp-input mt-1 w-full" value={newProfile.name} onChange={e=>setNewProfile({...newProfile,name:e.target.value})}/></label>
            <label className="erp-label">Base role<select className="erp-input mt-1 w-full" value={newProfile.baseRole} onChange={e=>setNewProfile({...newProfile,baseRole:e.target.value as Role,permissions:e.target.value==='owner'?Array.from(new Set([...newProfile.permissions,'write:owner'])):newProfile.permissions.filter(permission=>permission!=='write:owner')})}>{roles.map(role=><option key={role} value={role}>{role}</option>)}</select></label>
          </div>
          <fieldset className="mt-3"><legend className="font-bold text-slate-700">Allowed write areas</legend><div className="mt-2 flex flex-wrap gap-2">{permissionOptions.map(permission=><label key={permission} className="flex min-h-11 items-center gap-2 rounded border bg-slate-50 px-3"><input type="checkbox" checked={newProfile.permissions.includes(permission)} disabled={permission==='write:owner'&&newProfile.baseRole!=='owner'} onChange={e=>setNewProfile({...newProfile,permissions:e.target.checked?[...newProfile.permissions,permission]:newProfile.permissions.filter(item=>item!==permission)})}/>{permission.replace('write:','')}</label>)}</div></fieldset>
          <button type="button" disabled={busy||!newProfile.code||!newProfile.name} className="erp-btn erp-btn-primary mt-3 min-h-11" onClick={()=>void act(async()=>{await api.post('/permission-profiles',newProfile);setNewProfile({code:'',name:'',baseRole:'viewer',permissions:[],isActive:true});},'Custom permission profile created')}>Create permission profile</button>
        </section>

        <section className="overflow-hidden rounded border border-[#b8c9dd] bg-white shadow-sm xl:col-span-2">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 font-bold">Recent access audit</div>
          <div className="max-h-56 overflow-auto"><table className="w-full"><tbody>
            {(audit.data ?? []).map(entry => <tr key={entry.id} className="border-t border-slate-100"><td className="px-3 py-1.5">{new Date(entry.occurredAt).toLocaleString('en-IN')}</td><td className="px-3 py-1.5">{entry.actorName ?? 'System'}</td><td className="px-3 py-1.5">{entry.event.replaceAll('_', ' ')}</td><td className="px-3 py-1.5">{entry.targetName ?? '—'}</td></tr>)}
            {!audit.loading && (audit.data ?? []).length === 0 && <tr><td className="p-3 text-slate-500">No access changes recorded yet.</td></tr>}
          </tbody></table></div>
        </section>
      </div>
    </div>
  );
};
