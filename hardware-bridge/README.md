# Link ERP local hardware bridge

This optional loopback service sends the ERP's validated ZPL/TSPL bytes to a
network thermal printer without a browser print dialog. It can also read a
TCP-connected weighing scale. Chrome/Edge Web Serial remains the supported
path for a directly attached USB or RS-232 scale.

1. Install a maintained Node.js LTS runtime on the godown PC.
2. Copy `.env.example` to a protected service environment and replace every
   placeholder. `ALLOWED_ORIGIN` must exactly match the ERP's HTTPS origin.
3. Configure the same pairing token and loopback URLs when building the ERP
   web image. The bridge binds only to `127.0.0.1`; never expose its port on the
   LAN or internet.
4. Run `npm test`, then `npm start` under the operating system's service
   manager. Open `http://127.0.0.1:17420/health` locally to verify it is alive.
5. Print a calibration label and compare its barcode, physical dimensions and
   human-readable metres/kilograms to the ERP piece before pilot sign-off.

For Zebra/TSC-compatible network printers, use `PRINTER_MODE=tcp` and the
printer's allowlisted address/RAW port (normally 9100). Linux/macOS may instead
use `PRINTER_MODE=cups` with an allowlisted queue. The service accepts only
complete ZPL or TSPL jobs, caps each request at 1 MB, requires the exact browser
origin and pairing token, and forwards no business data anywhere else.
