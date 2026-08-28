import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ModuleNav } from './ModuleNav';

describe('ModuleNav', () => {
  test('the mobile menu exposes every group and closes after selection', () => {
    const pick = vi.fn();
    render(<ModuleNav activeModule="dashboard" onSelect={pick} role="owner" />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('button', { name: 'Company Setup & Controls' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'GSTR-1 B2B' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'GSTR-1 B2B' }));
    expect(pick).toHaveBeenCalledWith('gstr1_b2b');
    expect(screen.queryByRole('button', { name: 'Company Setup & Controls' })).not.toBeInTheDocument();
  });

  test('owner-only setup is not exposed to a store user', () => {
    render(<ModuleNav activeModule="dashboard" onSelect={() => {}} role="store" />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.queryByRole('button', { name: 'Company Setup & Controls' })).not.toBeInTheDocument();
  });

  /** The menu is the first thing a storekeeper reads, so it is the first thing
   * that has to be in his language — and it still has to select the same
   * module, because the English label is the key, not the caption. */
  test('the menu reads in Hindi, and still picks the right module', () => {
    localStorage.setItem('link-erp:lang', 'hi');
    try {
      const pick = vi.fn();
      render(<ModuleNav activeModule="dashboard" onSelect={pick} role="owner" />);
      fireEvent.click(screen.getByRole('button', { name: 'मेन्यू' }));
      expect(screen.getByRole('heading', { name: 'स्टॉक' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'डाइंग को इशू' }));
      expect(pick).toHaveBeenCalledWith('dyeing_issue');
    } finally {
      localStorage.removeItem('link-erp:lang');
    }
  });

  /** Statutory names are not translated: the department, the portal and the
   * accountant all call it GSTR-1, in every language. */
  test('statutory names stay as they are in Hindi', () => {
    localStorage.setItem('link-erp:lang', 'hi');
    try {
      render(<ModuleNav activeModule="dashboard" onSelect={() => {}} role="owner" />);
      fireEvent.click(screen.getByRole('button', { name: 'मेन्यू' }));
      expect(screen.getByRole('button', { name: 'GSTR-1 B2B' })).toBeInTheDocument();
    } finally {
      localStorage.removeItem('link-erp:lang');
    }
  });
});
