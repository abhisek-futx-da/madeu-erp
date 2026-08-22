import React, { useEffect, useState } from 'react';
import { CompanyBanner } from './components/CompanyBanner';
import { StatusBar } from './components/StatusBar';
import { LoginScreen } from './components/LoginScreen';
import { ModuleNav } from './components/ModuleNav';

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
import { ErrorBoundary } from './components/ErrorBoundary';
import { OfflineBadge } from './components/OfflineBadge';

import { auth, type Session } from './lib/api';
import { LogOut } from 'lucide-react';

export const App: React.FC = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [activeModule, setActiveModule] = useState<string>('dashboard');

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
    finally { setSession(null); }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[#dce5f0] text-slate-800 font-sans overflow-hidden">
      <CompanyBanner
        legalName={session.tenant?.legalName ?? '—'}
        gstin={session.tenant?.gstin ?? '—'}
        fyLabel={session.tenant?.fyLabel ?? '—'}
        online
      />

      <div className="flex items-stretch">
        <div className="flex-1 min-w-0">
          <ModuleNav activeModule={activeModule} onSelect={setActiveModule} />
        </div>
        <div className="bg-[#cbd5e1] border-b border-[#94a3b8] px-3 flex items-center gap-2 text-xs">
          <OfflineBadge />
          <span className="bg-emerald-100 text-emerald-900 px-2 py-0.5 rounded border border-emerald-300 font-mono font-bold">
            {session.role}
          </span>
          <button onClick={signOut} className="erp-btn py-0.5" title="Sign out">
            <LogOut className="w-3 h-3 text-red-600" />
            <span>Sign out</span>
          </button>
        </div>
      </div>

      <ErrorBoundary key={activeModule}>
      <div className="flex-1 overflow-hidden relative">
        {activeModule in MASTERS && (
          <MasterEditorView master={activeModule as keyof typeof MASTERS} />
        )}
        {activeModule === 'dashboard' && <DashboardView onOpen={setActiveModule} />}
        {activeModule === 'approvals' && <ApprovalView session={session} />}
        {activeModule === 'profit_loss' && <StatementView kind="profit_loss" />}
        {activeModule === 'balance_sheet' && <StatementView kind="balance_sheet" />}
        {activeModule === 'delivery_challans' && <DeliveryChallanView />}
        {activeModule === 'itc04' && <Itc04View />}
        {activeModule === 'eway_bills' && <EwayBillView />}
        {activeModule === 'grey_inward' && <LiveGreyInwardView />}
        {activeModule === 'dyeing_issue' && <ScanDocumentView kind="issue" />}
        {activeModule === 'grey_return' && <ScanDocumentView kind="grey_return" />}
        {activeModule === 'dyeing_return' && <ScanDocumentView kind="dyeing_return" />}
        {activeModule === 'customer_return' && <ScanDocumentView kind="customer_return" />}
        {activeModule === 'write_off' && <ScanDocumentView kind="write_off" />}
        {activeModule === 'dyeing_receipt' && <DyeingReceiptView />}
        {activeModule === 'cut_pack' && <ScanDocumentView kind="pack" />}
        {activeModule === 'regroup' && <PieceRegroupView session={session} />}
        {activeModule === 'stock_count' && <StockCountView />}
        {activeModule === 'dispatch' && <ScanDocumentView kind="dispatch" />}
        {activeModule === 'sales_orders' && <SalesOrderView />}
        {activeModule === 'year_close' && <YearCloseView />}
        {activeModule === 'payments' && <PaymentView />}
        {activeModule === 'audit_trail' && <AuditTrailView />}
        {activeModule === 'labels' && <BarcodeLabelView session={session} />}
        {activeModule === 'sales_invoices' && <SalesInvoiceView session={session} />}
        {activeModule === 'purchase_invoices' && <PurchaseInvoiceView />}
        {activeModule === 'gst_notes' && <GstNoteView />}
        {activeModule in REPORTS && (
          <LiveReportView report={activeModule as keyof typeof REPORTS} onOpen={setActiveModule} />
        )}
      </div>
      </ErrorBoundary>

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
