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
});
