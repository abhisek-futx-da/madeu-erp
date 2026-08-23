import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTabs } from './WorkspaceTabs';

const tabs = [
  { id: 'grey_inward', label: 'Grey Inward' },
  { id: 'sales_invoices', label: 'Tax Invoices' }
];

describe('WorkspaceTabs', () => {
  it('selects, closes and keyboard-switches open ERP screens', () => {
    const select = vi.fn();
    const close = vi.fn();
    render(<WorkspaceTabs tabs={tabs} activeId="grey_inward" onSelect={select} onClose={close} />);

    expect(screen.getByRole('tab', { name: 'Grey Inward' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Tax Invoices' }));
    expect(select).toHaveBeenCalledWith('sales_invoices');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Grey Inward' }), { key: 'ArrowRight' });
    expect(select).toHaveBeenLastCalledWith('sales_invoices');
    fireEvent.click(screen.getByRole('button', { name: 'Close Grey Inward' }));
    expect(close).toHaveBeenCalledWith('grey_inward');
  });
});
