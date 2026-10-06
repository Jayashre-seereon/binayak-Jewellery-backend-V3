# Barcode module — device integration guide

Binayak Jewellers ERP · backend module `src/services/barcodeService.js` (+ `src/services/barcode/*`,
`src/controllers/barcodeController.js`, `src/routes/barcodeRoutes.js`).

## 1. How the module works

```
 scanner ──(keystrokes or serial bytes)──▶ browser (sales screen) ──GET /api/barcode/scan/:code──▶ backend
                                                                          │
               ┌──────────────────────────────────────────────────────────┘
               ▼
   1. load the store's BarcodeConfig (defaults if none saved)
   2. clean the code: drop CR/LF/TAB/control chars + outer spaces, strip configured prefix/suffix
   3. look up, store-scoped and case-insensitive, in this order:
        Inventory.barcodeNo → Inventory.tagNo → Inventory.huidNo → Inventory.inventoryCode
        → Item.barcode (item code of MRP goods → the OLDEST AVAILABLE piece of that item, OLD-gold excluded)
   4. piece not AVAILABLE → 409 "Piece X is already SOLD" (also RESERVED / PENDING / DAMAGED / MELTED …)
      nothing found       → 404 "No stock or item found for barcode X"
   5. build a billing line: weights, purity, HUID, HSN, latest RateMaster sale rate, making-charge defaults
```

* **Rate** = latest `RateMaster.saleRate` for the piece's (metal, purity, grade); falls back to the
  purity-level rate (no grade), then any grade of that purity. `rateSource` tells which one was used
  (`RATE_MASTER_GRADE`, `RATE_MASTER_PURITY`, or `NONE` with `rate: 0` — the cashier must type a rate).
* **Making charge** defaults come from what was recorded at purchase: explicit
  `extraDetails.makingChargeType/makingChargeRate` → legacy `extraDetails.mkgChgPerGram` (`PER_GRAM`) →
  `PurchaseItem.makingCharges` as `PERCENT` (values above 100 cannot be a percentage and are sent as
  `FLAT` rupees) → otherwise `PERCENT 0`. No percentage is ever invented. `makingChargeSource` says which.
* The scan endpoint is **read-only**: it never reserves the piece. The sale itself (`POST /api/sales/create`)
  re-validates stock, so two counters scanning the same piece cannot both sell it.
* **Every piece has its own barcode** (`Inventory.barcodeNo`, unique in the store). It is created when the piece
  is tagged — *Inventory → Stock Entry* (or *Tag from Purchase*) — either **generated** (`89` + store(3) +
  sequence(7), Code 128) or **adopted** from the tag the piece already carries (scan/type it into the Barcode
  cell: manufacturer tag, hallmark-centre tag, the old Sagacity tag). A lost label is replaced with
  *Item Status → Change barcode* (`PUT /api/inventories/:id/barcode`); earlier codes are kept in history.
  All 7,173 migrated pieces keep their original Sagacity barcodes (e.g. `F20103000925`), so existing
  printed tags scan without relabelling.
* **Item codes** (optional, `Item.barcode`) are for fixed-price / MRP goods where every unit is identical
  (coins, watches, accessories). Generated codes are EAN-13 in the GS1 in-store range:
  `prefix(2, default "29") + storeId(3) + itemId(7) + check digit`, e.g. item 166 of store 1 →
  `2900100001663`; a manufacturer code can be assigned instead. Scanning an item code picks the oldest
  AVAILABLE piece of that item and the response carries a `notice` asking the cashier to check its weight.
  Products have no barcodes. All codes are unique per store and never collide with a piece's
  barcode/tag/inventory code (scan resolves pieces first).

## 2. Scanner configuration (per store)

`GET /api/barcode/config`, `PUT /api/barcode/config` (partial; unknown keys ignored, invalid values → 400).

| Key | Default | Meaning |
|---|---|---|
| `deviceMode` | `KEYBOARD_WEDGE` | `KEYBOARD_WEDGE` (USB/Bluetooth HID) or `SERIAL` (RS-232 / USB-COM via Web Serial) |
| `prefix`, `suffix` | `""` | printable characters the scanner adds around the data; stripped before lookup (≤16 chars) |
| `terminator` | `Enter` | key the scanner sends after the data: `Enter`, `Tab`, `None` |
| `minLength`, `maxLength` | 4, 64 | burst length accepted as a scan (shorter/longer bursts are treated as typing) |
| `interKeyTimeoutMs` | 50 | max gap between keystrokes of one scan (alias `scanTimeoutMs` accepted) |
| `autoAddToBill`, `beepOnScan`, `allowManualEntry` | true | sales-screen behaviour |
| `serialBaudRate` / `serialDataBits` / `serialStopBits` / `serialParity` | 9600 / 8 / 1 / `none` | must match the serial scanner |
| `symbology` | `CODE128` | for generated labels: `CODE128`, `EAN13`, `QRCODE` |
| `itemBarcodePrefix` | `29` | EAN-13 in-store prefix for item codes, 20–29 (old name `productBarcodePrefix` accepted) |
| `labelWidthMm` × `labelHeightMm` | 50 × 25 | label stock size |
| `labelFields` | storeName, itemName, purity, grossWeight, netWeight, huidNo, barcodeText, price | fields printed on piece labels |

### 2.1 USB / Bluetooth HID scanners (keyboard wedge) — recommended

The scanner behaves like a keyboard: it "types" the code and presses Enter. No driver is needed.

1. **Suffix = Enter (CR).** Scan the "Add CR suffix / Enter" programming barcode from the scanner's manual.
   Set `terminator: "Enter"` (or `Tab` if you programmed Tab).
2. **Prefix: disable it** (scan "Clear all prefixes"). If the scanner must keep one (e.g. `]C1` AIM IDs or a
   shop-specific `#`), put exactly that text in `prefix` so the backend strips it.
3. **Symbologies to enable:** Code 128 (piece tags, `89…` barcodes, legacy `H19…/F20…` codes),
   EAN-13 (item / manufacturer codes), QR Code (only if you print QR labels — needs a 2D/imager scanner).
   Disable rarely used ones (Codabar, ITF, MSI…) to avoid mis-reads.
4. **Keyboard layout / country** must match Windows (US/English-India), otherwise digits come out wrong.
5. **Disable "caps lock override" / case conversion**; lookups are case-insensitive anyway.
6. Bluetooth: pair as **HID keyboard** (not SPP). Set auto-sleep long enough; first scan after sleep may be lost.
7. **Test in Notepad:** open Notepad, scan a tag. You must see the code on one line, followed by a new line.
   Extra characters before/after → fix prefix/suffix; garbled digits → keyboard layout; nothing → HID mode off.
8. Frontend detection: characters arriving faster than `interKeyTimeoutMs` (50 ms) and ending in the terminator
   with a length between `minLength` and `maxLength` are treated as a scan; slower input is normal typing
   (so the cashier can still type a code when `allowManualEntry` is on).

### 2.2 Serial scanners (RS-232 or USB "virtual COM") — Web Serial

1. Set `deviceMode: "SERIAL"` and the port settings (`serialBaudRate`, `serialDataBits`, `serialStopBits`,
   `serialParity`) to **exactly** what the scanner uses (typical: 9600 8-N-1). Wrong baud/parity = garbage.
2. Browser: **Chrome or Edge** (desktop) only — Web Serial is not available in Firefox/Safari.
   The page must be served over **HTTPS or `http://localhost`**.
3. The user clicks "Connect scanner" once; the browser shows a port picker (`navigator.serial.requestPort()`),
   then the app opens it with the configured settings and reads lines terminated by CR/LF. Chrome remembers
   the permission for that site.
4. USB-COM scanners need the vendor's virtual COM driver on Windows (Device Manager → Ports shows `COMx`).
5. Each received line is sent to `GET /api/barcode/scan/:code`; CR/LF/TAB and the configured prefix/suffix are
   stripped server-side as well, so a stray terminator never breaks the lookup.

## 3. Label printers

* Stock: **50 × 25 mm** direct-thermal/thermal-transfer labels (jewellery tags may also use dumbbell/"rat tail"
  stock — set `labelWidthMm`/`labelHeightMm` to the printable area).
* Printer resolution **203 dpi** is enough for Code 128 / EAN-13 at this size; use 300 dpi for very long codes
  or tiny tags.
* Item-code labels: `GET /api/items/:id/barcode/label?copies=N` (N ≤ 200) returns a PDF with **one label per
  page and page size = label size**. Print from the PDF viewer with **"Actual size" / 100 % scale**, no
  "fit to page", margins none. In the printer driver set paper = 50 × 25 mm, media = labels with gaps
  (calibrate the gap sensor once), darkness medium.
* Piece labels (weights, purity, HUID, tag) come from the inventory module:
  `GET /api/inventories/label/:id`, `POST /api/inventories/labels/bulk`.
* Always scan a freshly printed label once — if it doesn't read, raise darkness or lower print speed.

## 4. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Scan does nothing in the sales screen | scanner sends no terminator | program "Enter suffix", `terminator: "Enter"` |
| Code appears in a search box instead of the bill | focus elsewhere / typing too slow | click the scan box; check `interKeyTimeoutMs` (raise to 80–100 for Bluetooth) |
| 404 "No stock or item found" for a real tag | extra prefix/suffix, wrong store selected, or piece in another store | test in Notepad; set `prefix`/`suffix`; check the store selector |
| 409 "Piece X is already SOLD" | piece sold/reserved/damaged/in transfer | check the piece in Stock; cancel the sale or change status |
| 409 "... has no AVAILABLE stock" (item code) | all pieces of that item sold | tag new stock (Stock Entry) or bill another item |
| Digits wrong (e.g. `é"'` instead of `234`) | keyboard layout mismatch | set scanner country = US/English |
| Serial: garbage characters | baud/parity mismatch | match `serialBaudRate`/`serialParity`/bits to the scanner |
| Serial: "Connect scanner" button missing | not Chrome/Edge, or not HTTPS/localhost | use Chrome/Edge over HTTPS |
| EAN-13 assign rejected | wrong check digit (typo) | re-scan rather than type; the error shows the expected check digit |
| Label prints shrunk / shifted | PDF printed with "fit to page" | print at 100 %, paper size 50 × 25 mm, calibrate gaps |
| Barcode on label won't scan | too light / quiet zone cut / low dpi | raise darkness, don't trim label edges, use 300 dpi for long codes |

## 5. API reference

All endpoints need `Authorization: Bearer <token>`; ADMIN users must pass `?storeId=`. Store users are always
scoped to their own store. Errors: `{ success:false, message }`.

| Method & path | Body / query | Response |
|---|---|---|
| `GET /api/barcode/config` | – | `{success, data: BarcodeConfig}` |
| `PUT /api/barcode/config` | partial BarcodeConfig | `{success, data: BarcodeConfig}` (400 on invalid values) |
| `GET /api/barcode/scan/:code` (or `/scan?code=`) | – | `{success, data:{matchType:"INVENTORY"\|"ITEM", matchedOn, code, cleanedCode, inventory, item, notice, billingLine}}` · 404 · 409 (`data` carries `status`, `inventoryId`) |
| `GET /api/barcode/image/:code` | `symbology=CODE128\|EAN13\|QRCODE` (default: EAN-13 for valid EAN-13, else Code 128), `scale` 1–8 (3), `height` 4–40 mm (12), `includeText` 1/0 | `image/png` |
| `POST /api/items/:id/barcode/generate` | `{replace?: true}` | 201 `{success, data:{barcode, item, generated}}` (200 if the item already had one and `replace` not set) |
| `PUT /api/items/:id/barcode` | `{barcode}` | `{success, data:{barcode, item}}` · 400 invalid · 409 used by another item / a stock piece |
| `DELETE /api/items/:id/barcode` | – | `{success, data:item}` |
| `GET /api/items/:id/barcode/label` | `copies` 1–200 | `application/pdf` (409 if the item has no code) |
| `POST /api/items/create` | optional `barcode`, or `generateBarcode: "true"` | item incl. `barcode` |
| `POST /api/stock/entries` | `{mode: OPENING\|PURCHASE, date, partyId?, lines:[{itemId, purityId?, grossWeight, stoneWeight?, huidNo?, barcode?, …}]}` | 201 `{success, data:{purchase, pieces:[{id, barcodeNo, …}]}}` · 400/409 `Row N: …` |
| `GET /api/stock/barcode-check?code=` | – | `{success, data:{available, usedBy}}` |
| `PUT /api/inventories/:id/barcode` | `{barcode}` | re-labels an AVAILABLE/RESERVED piece |

`billingLine` fields: `inventoryId, itemCode, inventoryCode, barcodeNo, tagNo, particulars, huidNo, hsnCode,
purityName, purity, gradeName, pieces, grossWeight, stoneWeight, netWeight, rate, rateSource, rateDate,
makingChargeType (PERCENT|PER_GRAM|FLAT), makingChargeRate, makingChargeSource, stoneAmount, otherCharges,
metalId, purityId, gradeId, productId, itemId, metalName, productName, itemName`.

Barcode value rules: 13 digits → must pass the EAN-13 checksum; otherwise 4–48 printable ASCII characters
without spaces (encoded as Code 128).
