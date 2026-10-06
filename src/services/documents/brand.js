import prisma from "../../config/db.js";
import { publicStoreSelect } from "../../utils/publicSelect.js";
import { clean, panFromGstin, upper } from "./format.js";

export const DEFAULT_STORE_STATE = "ODISHA";

const splitLines = (value) =>
  String(value || "")
    .split(/\r?\n|;|•/)
    .map((line) => clean(line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "")))
    .filter(Boolean);

/** Store letterhead data, built only from the Store master (never hard-coded fallbacks). */
export const buildBrand = (store = {}) => {
  const name = clean(store.storeName) || "Store";
  const address = clean(store.address);
  const location = clean(store.location);
  const city = clean(store.city);
  const state = upper(store.state);
  const cityState = [city, state].filter(Boolean).join(", ");
  const addressLines = [];
  if (address) addressLines.push(address);
  if (location && !address.toLowerCase().includes(location.toLowerCase())) addressLines.push(location);
  if (cityState && !addressLines.join(" ").toLowerCase().includes(cityState.toLowerCase())) addressLines.push(cityState);
  const gstin = upper(store.gstNo);

  return {
    id: store.id,
    name,
    shortName: name.toUpperCase(),
    addressLines,
    city,
    phone: clean(store.phone),
    gstin,
    pan: panFromGstin(gstin),
    cin: upper(store.cinNo),
    state: state || DEFAULT_STORE_STATE,
    hasState: Boolean(state),
    tagline: clean(store.tagline),
    terms: splitLines(store.termsConditions),
  };
};

/** Accepts a Store row (any select) or a store id; always re-reads the safe public fields. */
export const loadBrand = async (storeOrId) => {
  const id = typeof storeOrId === "object" && storeOrId !== null ? storeOrId.id : storeOrId;
  let store = typeof storeOrId === "object" && storeOrId !== null ? storeOrId : null;
  if (id) {
    const fresh = await prisma.store.findUnique({ where: { id: Number(id) }, select: publicStoreSelect });
    if (fresh) store = fresh;
  }
  return buildBrand(store || {});
};
