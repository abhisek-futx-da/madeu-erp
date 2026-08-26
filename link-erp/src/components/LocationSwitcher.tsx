import React, { useState } from 'react';
import { Building2 } from 'lucide-react';
import { api, type BusinessLocation } from '../lib/api';
import { clearApiCache, useApi } from '../lib/useApi';

export const LocationSwitcher: React.FC<{
  current: BusinessLocation | null;
  onChanged: (location: BusinessLocation) => void;
}> = ({ current,onChanged }) => {
  const locations=useApi<BusinessLocation[]>('/locations');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const change=async(id:string)=>{
    const location=(locations.data??[]).find(row=>row.id===id);if(!location||location.id===current?.id)return;
    setBusy(true);setError('');
    try{
      const selected=await api.post<BusinessLocation>('/locations/active',{locationId:id});
      clearApiCache();onChanged({...location,...selected});
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  return <div className="flex items-center gap-1">
    <Building2 className="h-3.5 w-3.5 text-blue-900" aria-hidden="true" />
    <label className="sr-only" htmlFor="active-business-location">Active business location</label>
    <select id="active-business-location" disabled={busy||locations.loading}
      className="min-h-11 max-w-48 rounded border border-blue-300 bg-blue-50 px-2 font-semibold text-blue-950 disabled:opacity-60"
      value={current?.id??''} onChange={event=>void change(event.target.value)}>
      {(locations.data??[]).filter(row=>row.is_active).map(location=><option key={location.id} value={location.id}>{location.code} — {location.name}</option>)}
    </select>
    {error&&<span role="alert" className="max-w-48 truncate text-red-800" title={error}>{error}</span>}
  </div>;
};
