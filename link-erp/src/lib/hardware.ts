export type ThermalLanguage = 'zpl' | 'tspl';

export interface ThermalLabel {
  barcode: string;
  mill: string;
  quality: string;
  grade: string;
  lot: string;
  metres: number;
  kilograms?: number | null;
}

const printable = (value: string) => value.replace(/[^ A-Za-z0-9./_-]/g, ' ').trim().slice(0, 50);
const barcode = (value: string) => value.replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 40);

export function thermalCommands(language: ThermalLanguage, labels: ThermalLabel[]) {
  if (language === 'zpl') {
    return labels.map(label => `^XA
^PW520
^LL280
^FO25,18^A0N,28,24^FD${printable(label.mill)}^FS
^FO25,50^A0N,22,18^FD${printable(label.quality)} / ${printable(label.grade)}  LOT ${printable(label.lot || '-') }^FS
^FO28,82^BY2,2,70^BCN,70,Y,N,N^FD${barcode(label.barcode)}^FS
^FO25,205^A0N,24,20^FD${label.metres.toFixed(2)} MTR${label.kilograms == null ? '' : `  ${label.kilograms.toFixed(3)} KG`}^FS
^XZ`).join('\n');
  }
  return labels.map(label => `SIZE 65 mm,35 mm
GAP 2 mm,0
DIRECTION 1
CLS
TEXT 25,15,"3",0,1,1,"${printable(label.mill)}"
TEXT 25,48,"2",0,1,1,"${printable(label.quality)} / ${printable(label.grade)} LOT ${printable(label.lot || '-')}"
BARCODE 25,78,"128",70,1,0,2,2,"${barcode(label.barcode)}"
TEXT 25,210,"3",0,1,1,"${label.metres.toFixed(2)} MTR${label.kilograms == null ? '' : `  ${label.kilograms.toFixed(3)} KG`}"
PRINT 1,1`).join('\n');
}

function downloadRaw(contents: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * A configured local bridge sends bytes straight to the printer. Without one,
 * the exact same printer-language file is downloaded for the OS spool command.
 */
export async function printThermal(
  language: ThermalLanguage, labels: ThermalLabel[]
): Promise<'bridge' | 'download'> {
  if (labels.length === 0) throw new Error('select at least one label');
  const raw = thermalCommands(language, labels);
  const bridge = import.meta.env.VITE_PRINT_BRIDGE_URL as string | undefined;
  if (!bridge) {
    downloadRaw(raw, `link-erp-labels-${Date.now()}.${language}`);
    return 'download';
  }
  const pairingToken = import.meta.env.VITE_HARDWARE_BRIDGE_TOKEN as string | undefined;
  const response = await fetch(bridge, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-printer-language': language,
      ...(pairingToken ? { 'x-bridge-token': pairingToken } : {}) },
    body: raw
  });
  if (!response.ok) throw new Error(`local print bridge returned ${response.status}`);
  return 'bridge';
}

const firstWeight = (text: string) => {
  const match = /(-?\d+(?:\.\d+)?)/.exec(text);
  if (!match) throw new Error('the scale returned no numeric weight');
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0 || value > 5000) {
    throw new Error(`scale returned an invalid weight: ${match[1]}`);
  }
  return Math.round(value * 1000) / 1000;
};

/** Reads either an approved local scale bridge or a user-selected serial scale. */
export async function captureScaleKg(): Promise<number> {
  const bridge = import.meta.env.VITE_SCALE_BRIDGE_URL as string | undefined;
  if (bridge) {
    const pairingToken = import.meta.env.VITE_HARDWARE_BRIDGE_TOKEN as string | undefined;
    const response = await fetch(bridge, { headers: { accept: 'application/json,text/plain',
      ...(pairingToken ? { 'x-bridge-token': pairingToken } : {}) } });
    if (!response.ok) throw new Error(`local scale bridge returned ${response.status}`);
    const text = await response.text();
    try {
      const body = JSON.parse(text);
      return firstWeight(String(body.kilograms ?? body.kg ?? body.weight ?? ''));
    } catch {
      return firstWeight(text);
    }
  }

  type SerialPort = {
    open(options: { baudRate: number }): Promise<void>;
    close(): Promise<void>;
    readable: ReadableStream<Uint8Array> | null;
  };
  const serial = (navigator as Navigator & {
    serial?: { requestPort(): Promise<SerialPort> }
  }).serial;
  if (!serial) throw new Error('no scale bridge configured and this browser has no Web Serial support');

  const port = await serial.requestPort();
  await port.open({ baudRate: Number(import.meta.env.VITE_SCALE_BAUD_RATE ?? 9600) });
  const reader = port.readable?.getReader();
  if (!reader) {
    await port.close();
    throw new Error('the selected scale has no readable serial stream');
  }
  try {
    const deadline = Date.now() + 5000;
    let text = '';
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>(resolve =>
          window.setTimeout(() => resolve({ done: true }), 750))
      ]);
      if (result.value) text += new TextDecoder().decode(result.value);
      if (/\d+(?:\.\d+)?/.test(text) && (/\r|\n|kg/i.test(text))) return firstWeight(text);
      if (result.done && text) return firstWeight(text);
    }
    throw new Error('scale did not answer within 5 seconds');
  } finally {
    reader.releaseLock();
    await port.close();
  }
}
