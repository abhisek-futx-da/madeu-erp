import { describe, expect, test, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageSwitcher } from './LanguageSwitcher';
import { ScanDocumentView } from '../modules/ScanDocumentView';
import { writeLang } from '../lib/i18n';

/**
 * The floor reads Hindi or Gujarati first. Switching has to change the words a
 * storekeeper actually looks at, and an unreviewed language has to say so —
 * in that language, where he will see it.
 */
beforeEach(() => {
  writeLang('en');
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, headers: new Headers(), text: async () => '[]'
  } as unknown as Response)));
});

describe('LanguageSwitcher', () => {
  test('English is offered and carries no warning, because it is the source', () => {
    render(<LanguageSwitcher />);
    expect(screen.getByLabelText('Language')).toHaveValue('en');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('an unreviewed language warns, in that language', () => {
    render(<LanguageSwitcher />);
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'hi' } });

    const warning = screen.getByRole('status');
    expect(warning).toBeInTheDocument();
    // The warning itself is translated: a storekeeper who cannot read English
    // is exactly the person who needs to know the words are unchecked.
    expect(warning.textContent).toMatch(/स्थानीय भाषी/);
  });

  test('the choice survives a reload, so the floor sets it once', () => {
    const { unmount } = render(<LanguageSwitcher />);
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'gu' } });
    unmount();

    render(<LanguageSwitcher />);
    expect(screen.getByLabelText('Language')).toHaveValue('gu');
  });
});

describe('the floor screen follows the switch', () => {
  test('the scan screen speaks Hindi when Hindi is chosen', async () => {
    writeLang('hi');
    render(<ScanDocumentView kind="issue" />);

    // The heading and the party label are the two things read most.
    await waitFor(() =>
      expect(screen.getByText(/डाइंग को इशू/)).toBeInTheDocument());
    expect(screen.getByText(/प्रोसेस हाउस/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('स्कैन करें या लिखें, फिर Enter')).toBeInTheDocument();
  });

  test('an untranslated string still reads, in English, rather than blank', async () => {
    writeLang('gu');
    render(<ScanDocumentView kind="issue" />);

    // Nothing on a working screen may render empty or as a raw key.
    await waitFor(() => expect(screen.getByText(/ડાઇંગ માટે ઇશ્યુ/)).toBeInTheDocument());
    expect(document.body.textContent).not.toMatch(/undefined|\[object|^\s*$/);
  });
});
