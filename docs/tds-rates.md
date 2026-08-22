# TDS rates and thresholds — where the seeded values came from

`011_seed_tds.sql` seeds `tax_deduction_section`. The rates live in a **table,
not in code**, precisely because they change; the seed is a starting point that
a mill's CA must confirm each year.

Read from these sources on **2026-08-21**:

| Source | Used for |
|---|---|
| [Section 194C contractor payments — rates and thresholds](https://batchwise.ai/tds/section-194c-contractor-payments/) | 194C 1% / 2%, ₹30,000 single and ₹1,00,000 aggregate thresholds, 20% without PAN |
| [Section 194Q overview — ClearTax](https://cleartax.in/s/an-overview-on-section-194q-of-the-income-tax-act-1961-ita) | 194Q 0.1% on the excess over ₹50 lakh |
| [TDS rate chart FY 2026-27 — sections 392 & 393](https://taxgarden.in/blog/tds-rate-chart-2026-to-2027) | Act 2025 consolidation |
| [TDS/TCS rate chart FY 2025-26](https://blog.tdsman.com/2025/05/tds-tcs-rate-chart-fy-2025-26-ay-2026-27/) | Cross-check |

## Things that would have been wrong from memory

- **TCS under 206C(1H) was removed with effect from 1 April 2025.** Sale-side
  TCS on goods is *not* seeded, because it no longer applies; 194Q on the
  buyer's side now governs high-value goods transactions. Seeding it would have
  produced tax the mill must not collect.
- **Section 206AB was omitted from 1 April 2025**, so there is no
  compliance-portal check before applying the standard rate.
- **FY 2026-27 is the first full year under the Income Tax Act 2025**, where the
  old numbered sections are consolidated into section 392 (salary) and 393
  (everything else). The familiar 194C/194Q labels are kept here because that is
  what accountants still say, but the section codes are free text in the table
  and can be renamed without a migration.
- The two threshold rules are genuinely different and the code models both:
  194Q charges only on the **excess** over the threshold, while 194C charges on
  the **whole amount once** the threshold is crossed.

## Not verified

- Whether a given mill's turnover exceeds the ₹10 crore previous-year limit that
  makes 194Q apply to it at all. That is a per-tenant fact and is left as
  configuration — remove the 194Q row for a tenant it does not apply to.
- Surcharge and cess treatment on TDS, which is not modelled.
