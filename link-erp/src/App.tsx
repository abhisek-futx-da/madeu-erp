import React, { useEffect, useMemo, useState } from 'react';
import { CompanyBanner } from './components/CompanyBanner';
import { StatusBar } from './components/StatusBar';
import { LoginScreen } from './components/LoginScreen';
import { ModuleNav, NAV } from './components/ModuleNav';
import { WorkspaceTabs } from './components/WorkspaceTabs';

import { LiveGreyInwardView } from './modules/LiveGreyInwardView';
import { ScanDocumentView } from './modules/ScanDocumentView';
import { DyeingReceiptView } from './modules/DyeingReceiptView';
import { LiveReportView, REPORTS } from './modules/LiveReportView';
import { MasterEditorView, MASTERS } from './modules/MasterEditorView';
import { SalesInvoiceView } from './modules/SalesInvoiceView';
import { PurchaseInvoiceView } from './modules/PurchaseInvoiceView';
import { GstNoteView } from './modules/GstNoteView';
import { SalesOrderView } from './modules/SalesOrderView';
import { YearCloseView } from './modules/YearCloseView';
import { PaymentView } from './modules/PaymentView';
import { AuditTrailView } from './modules/AuditTrailView';
import { BarcodeLabelView } from './modules/BarcodeLabelView';
import { DashboardView } from './modules/DashboardView';
import { ApprovalView } from './modules/ApprovalView';
import { StatementView } from './modules/StatementView';
import { DeliveryChallanView } from './modules/DeliveryChallanView';
import { Itc04View } from './modules/Itc04View';
import { EwayBillView } from './modules/EwayBillView';
import { PieceRegroupView } from './modules/PieceRegroupView';
import { StockCountView } from './modules/StockCountView';
import { ProcessHouseInboxView } from './modules/ProcessHouseInboxView';
import { OfflineQueueView } from './modules/OfflineQueueView';
import { PartyAliasView } from './modules/PartyAliasView';
import { LedgerView } from './modules/LedgerView';
import { LotReceiptView } from './modules/LotReceiptView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OfflineBadge } from './components/OfflineBadge';
import { PasswordView } from './modules/PasswordView';
import { UserAdminView } from './modules/UserAdminView';
import { CompanySetupView } from './modules/CompanySetupView';
import { BankReconciliationView } from './modules/BankReconciliationView';
import { PurchaseOrderView } from './modules/PurchaseOrderView';
import { ReprocessView } from './modules/ReprocessView';
import { PackingListView } from './modules/PackingListView';
import { MillIntegrationView } from './modules/MillIntegrationView';
import { OnboardingView } from './modules/OnboardingView';
import { GlobalSearchView } from './modules/GlobalSearchView';
import { CommercialFoundationView } from './modules/CommercialFoundationView';
import { LocationTransferView } from './modules/LocationTransferView';
import { PlatformStudioView } from './modules/PlatformStudioView';
import { EditionWorkspaceView } from './modules/EditionWorkspaceView';

import { auth, type Session } from './lib/api';
import { clearApiCache } from './lib/useApi';
import { LogOut } from 'lucide-react';
import { LocationSwitcher } from './components/LocationSwitcher';
import { LanguageSwitcher } from './components/LanguageSwitcher';

export const App: React.FC = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const validModules = useMemo(() => new Set(NAV.flatMap(group => group.items.map(item => item.id))), []);
  const moduleFromUrl = () => {
    const requested = window.location.hash.replace(/^#\/?/, '').split('?', 1)[0]!;
    return validModules.has(requested) ? requested : 'dashboard';
  };
  const [activeModule, setActiveModule] = useState<string>(() => moduleFromUrl());
  const [openModules, setOpenModules] = useState<string[]>(() => [moduleFromUrl()]);
  const labels = useMemo(() => new Map(
    NAV.flatMap(group => group.items.map(item => [item.id, item.label] as const))
  ), []);

  useEffect(() => {
    const sync = () => setActiveModule(moduleFromUrl());
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  // validModules is stable for the lifetime of the application.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = (module: string, query?: string) => {
    if (!validModules.has(module)) return;
    setOpenModules(current => current.includes(module)
      ? current
      : [...current.slice(-7), module]);
    const target = `#/${module}${query ? `?q=${encodeURIComponent(query)}` : ''}`;
    window.history.pushState(null, '', target);
    setActiveModule(module);
    if (query) queueMicrotask(() => window.dispatchEvent(new CustomEvent('erp-module-search', {
      detail: { module, query }
    })));
  };

  useEffect(() => {
    setOpenModules(current => current.includes(activeModule)
      ? current
      : [...current.slice(-7), activeModule]);
  }, [activeModule]);

  const closeModule = (module: string) => {
    setOpenModules(current => {
      if (current.length === 1) return current;
      const index = current.indexOf(module);
      if (index < 0) return current;
      const remaining = current.filter(id => id !== module);
      if (module === activeModule) {
        const next = remaining[Math.min(index, remaining.length - 1)]!;
        window.history.replaceState(null, '', `#/${next}`);
        setActiveModule(next);
      }
      return remaining;
    });
  };

  // The browser session is an HttpOnly cookie. Ask the server whether it is
  // still valid; there is deliberately no bearer token in web storage.
  useEffect(() => {
    auth.me()
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#dce5f0] text-slate-600 text-sm">
        Connecting to Link ERP…
      </div>
    );
  }

  if (!session) {
    return (
      <LoginScreen
        onSignedIn={() => {
          auth.me().then(setSession).catch(() => setSession(null));
        }}
      />
    );
  }

  const signOut = async () => {
    try { await auth.logout(); }
    finally {
      clearApiCache();
      setSession(null);
    }
  };

  const moduleView = (module: string) => (
    <>
      {module in MASTERS && <MasterEditorView master={module as keyof typeof MASTERS} />}
      {module === 'dashboard' && <DashboardView onOpen={navigate} />}
      {module === 'global_search' && <GlobalSearchView onOpen={navigate} />}
      {module === 'approvals' && <ApprovalView session={session} />}
      {module === 'password' && <PasswordView />}
      {module === 'users' && <UserAdminView session={session} />}
      {module === 'company_setup' && <CompanySetupView />}
      {module === 'go_live_readiness' && <CommercialFoundationView session={session} />}
      {module === 'platform_studio' && <PlatformStudioView />}
      {module.startsWith('edition_') && <EditionWorkspaceView edition={module.replace('edition_','') as 'weaving'|'dyeing'|'exports'|'logistics'|'garments'} session={session} />}
      {module === 'profit_loss' && <StatementView kind="profit_loss" />}
      {module === 'balance_sheet' && <StatementView kind="balance_sheet" />}
      {module === 'delivery_challans' && <DeliveryChallanView />}
      {module === 'itc04' && <Itc04View />}
      {module === 'eway_bills' && <EwayBillView />}
      {module === 'grey_inward' && <LiveGreyInwardView />}
      {module === 'dyeing_issue' && <ScanDocumentView kind="issue" />}
      {module === 'grey_return' && <ScanDocumentView kind="grey_return" />}
      {module === 'dyeing_return' && <ScanDocumentView kind="dyeing_return" />}
      {module === 'customer_return' && <ScanDocumentView kind="customer_return" />}
      {module === 'write_off' && <ScanDocumentView kind="write_off" />}
      {module === 'dyeing_receipt' && <DyeingReceiptView />}
      {module === 'lot_receipt' && <LotReceiptView />}
      {module === 'reprocess' && <ReprocessView />}
      {module === 'cut_pack' && <ScanDocumentView kind="pack" />}
      {module === 'regroup' && <PieceRegroupView session={session} />}
      {module === 'stock_count' && <StockCountView />}
      {module === 'process_houses' && <ProcessHouseInboxView session={session} />}
      {module === 'offline_queue' && <OfflineQueueView />}
      {module === 'party_aliases' && <PartyAliasView />}
      {module === 'ledger' && <LedgerView />}
      {module === 'location_transfers' && <LocationTransferView session={session} />}
      {module === 'dispatch' && <ScanDocumentView kind="dispatch" />}
      {module === 'packing_lists' && <PackingListView />}
      {module === 'purchase_orders' && <PurchaseOrderView />}
      {module === 'sales_orders' && <SalesOrderView />}
      {module === 'year_close' && <YearCloseView />}
      {module === 'payments' && <PaymentView />}
      {module === 'mill_integrations' && <MillIntegrationView />}
      {module === 'data_onboarding' && <OnboardingView />}
      {module === 'bank_reconciliation' && <BankReconciliationView session={session} />}
      {module === 'audit_trail' && <AuditTrailView />}
      {module === 'labels' && <BarcodeLabelView session={session} />}
      {module === 'sales_invoices' && <SalesInvoiceView session={session} />}
      {module === 'purchase_invoices' && <PurchaseInvoiceView />}
      {module === 'gst_notes' && <GstNoteView />}
      {module in REPORTS && <LiveReportView report={module as keyof typeof REPORTS} onOpen={navigate} />}
    </>
  );

  return (
    <div className="flex flex-col min-h-screen h-[100dvh] w-screen bg-[#dce5f0] text-slate-800 font-sans overflow-hidden">
      <CompanyBanner
        legalName={session.tenant?.legalName ?? '—'}
        gstin={session.tenant?.gstin ?? '—'}
        fyLabel={session.tenant?.fyLabel ?? '—'}
        online
      />

      <div className="flex flex-col md:flex-row md:items-stretch">
        <div className="flex-1 min-w-0">
          <ModuleNav activeModule={activeModule} onSelect={navigate} role={session.role} />
        </div>
        {/* Wraps: on a phone this row carries offline, language, location,
            role and sign-out, and without it the first control runs off the
            left edge where a thumb cannot reach it. */}
        <div className="bg-[#cbd5e1] border-b border-[#94a3b8] px-3 py-1 flex flex-wrap items-center justify-end gap-2 text-xs min-h-11">
          <OfflineBadge />
          <LanguageSwitcher />
          <LocationSwitcher current={session.activeLocation ?? null} onChanged={activeLocation =>
            setSession(current => current ? { ...current,activeLocation } : current)} />
          <span className="bg-emerald-100 text-emerald-900 px-2 py-0.5 rounded border border-emerald-300 font-mono font-bold">
            {session.role}
          </span>
          <button onClick={signOut} className="erp-btn py-0.5" title="Sign out">
            <LogOut className="w-3 h-3 text-red-600" />
            <span>Sign out</span>
          </button>
        </div>
      </div>

      <WorkspaceTabs
        tabs={openModules.map(id => ({ id, label: labels.get(id) ?? id }))}
        activeId={activeModule} onSelect={navigate} onClose={closeModule}
      />
      <div className="flex-1 overflow-hidden relative">
        {openModules.map(module => (
          <section key={module} role="tabpanel" id={`workspace-panel-${module}`}
            aria-labelledby={`workspace-tab-${module}`}
            className={module === activeModule ? 'h-full' : 'hidden'}>
            <ErrorBoundary>{moduleView(module)}</ErrorBoundary>
          </section>
        ))}
      </div>

      <StatusBar
        currentForm={activeModule}
        tenantName={session.tenant?.legalName ?? '—'}
        gstin={session.tenant?.gstin ?? '—'}
        userEmail={session.user?.email ?? '—'}
        online
      />
    </div>
  );
};

export default App;
