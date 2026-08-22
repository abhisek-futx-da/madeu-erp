import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolbarRibbon } from './ToolbarRibbon';

/**
 * The audit found 96 buttons across thirteen screens whose onClick was
 * undefined — they rendered, they were clickable, and nothing happened. These
 * tests exist so that cannot come back.
 */
describe('ToolbarRibbon', () => {
  test('renders no button without a handler behind it', () => {
    render(<ToolbarRibbon title="Tax Invoices" />);
    for (const label of ['Save', 'New', 'Print', 'Find', 'Export', 'Reset']) {
      expect(screen.queryByRole('button', { name: new RegExp(label, 'i') })).toBeNull();
    }
  });

  test('every rendered button actually fires', () => {
    const save = vi.fn();
    const print = vi.fn();
    render(<ToolbarRibbon title="Tax Invoices" onSave={save} onPrint={print} />);

    for (const btn of screen.getAllByRole('button')) fireEvent.click(btn);

    expect(save).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledTimes(1);
  });

  test('the advertised keyboard shortcuts are wired, not decoration', () => {
    const save = vi.fn();
    const find = vi.fn();
    render(<ToolbarRibbon title="Payments" onSave={save} onFind={find} />);

    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });

    expect(save).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledTimes(1);
  });

  test('a shortcut for an action this screen does not have does nothing', () => {
    const save = vi.fn();
    render(<ToolbarRibbon title="Reports" onSave={save} />);
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(save).not.toHaveBeenCalled();
  });

  test('a disabled action neither fires on click nor on its shortcut', () => {
    const save = vi.fn();
    render(<ToolbarRibbon title="Closed Year"
      actions={[{ key: 'save', onRun: save, disabled: true, hint: 'the year is closed' }]} />);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(save).not.toHaveBeenCalled();
  });

  test('the shortcut hint lists exactly the actions on screen', () => {
    render(<ToolbarRibbon title="Dispatch" onSave={() => {}} onPrint={() => {}} />);
    const hint = screen.getByText(/Ctrl\+S Save/);
    expect(hint.textContent).toContain('Ctrl+P Print');
    expect(hint.textContent).not.toContain('Delete');
  });
});
