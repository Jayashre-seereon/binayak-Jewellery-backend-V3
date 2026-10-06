import prisma from "../config/db.js";
import {
  createItemRepo,
  getItemsByStore,
  getItemOptionsRepo,
  getItemsByProductIdRepo,
  getItemByIdRepo,
  updateItemRepo,
  deleteItemRepo,
} from "../repositories/itemRepository.js";
import { AppError, assertUniqueName, cleanString } from "../utils/validate.js";
import { assertRef, blankableId, nameChanged, rethrowDeleteError } from "../utils/errorHandler.js";
import { validateBarcodeValue } from "./barcode/symbology.js";
import { assertBarcodeAvailable, generateItemBarcode } from "./barcodeService.js";

const loadOwnedItem = async (id, storeId) => {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new AppError("Invalid item id.");
  const item = await getItemByIdRepo(n, Number(storeId));
  if (!item) throw new AppError("Item not found.", 404);
  return item;
};

const truthy = (v) => [true, "true", "1", 1, "on", "yes"].includes(v);

// Create Item — only the name is required; product, design and purity are optional
// (legacy items are shared across products). Optional item code: typed/scanned or generated.
export const createItem = async (data, storeId) => {
  const productId = blankableId(data.productId, "product");
  const product = productId ? await assertRef(prisma.product, productId, storeId, "Product") : null;

  const designId = blankableId(data.designId, "design");
  const design = designId ? await assertRef(prisma.design, designId, storeId, "Design") : null;

  const purityId = blankableId(data.purityId, "purity");
  const purity = purityId ? await assertRef(prisma.purity, purityId, storeId, "Purity") : null;

  const name = await assertUniqueName(prisma.item, { storeId, name: data.name, label: "Item" });

  let barcode = null;
  if (data.barcode !== undefined && data.barcode !== null && String(data.barcode).trim() !== "") {
    barcode = validateBarcodeValue(data.barcode);
    await assertBarcodeAvailable(storeId, barcode);
  }

  const created = await createItemRepo({
    name,
    description: cleanString(data.description),
    image: data.image || null,
    productId: product ? product.id : null,
    designId: design ? design.id : null,
    purityId: purity ? purity.id : product?.purityId || null,
    barcode,
    storeId: Number(storeId),
  });
  if (!barcode && truthy(data.generateBarcode)) {
    return (await generateItemBarcode(storeId, created.id)).item;
  }
  return created;
};

// Get All Items (paginated grid)
export const getItems = async (storeId, page = 1, limit = 10, search = "") => {
  page = Math.max(1, Math.floor(Number(page)) || 1);
  limit = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 10));
  const skip = (page - 1) * limit;

  const result = await getItemsByStore(Number(storeId), skip, limit, search);
  const totalPages = Math.ceil(result.total / limit);

  return {
    items: result.items,
    pagination: {
      page,
      limit,
      total: result.total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    },
  };
};

// Dropdown source: every item of the store, lean shape (CONTRACT §2).
export const getItemOptions = async (storeId, search = "") => {
  const rows = await getItemOptionsRepo(Number(storeId), String(search || "").slice(0, 100));
  return rows;
};

// Get Items By Product Id
export const getItemsByProductId = async (productId, storeId) => {
  if (!Number.isInteger(Number(productId)) || Number(productId) <= 0) throw new AppError("Product ID is required.");
  return getItemsByProductIdRepo(Number(productId), Number(storeId));
};

// Get Item By Id
export const getItemById = async (id, storeId) => loadOwnedItem(id, storeId);

// Update Item (whitelisted fields; every referenced id must be in the same store)
export const updateItem = async (id, data, storeId) => {
  const item = await loadOwnedItem(id, storeId);
  const update = {};

  if (nameChanged(data.name, item.name)) {
    update.name = await assertUniqueName(prisma.item, { storeId, name: data.name, excludeId: item.id, label: "Item" });
  }
  if (data.description !== undefined) update.description = cleanString(data.description);
  if (data.image !== undefined) update.image = data.image;

  let product = null;
  if (data.productId !== undefined && data.productId !== null && data.productId !== "") {
    product = await assertRef(prisma.product, data.productId, storeId, "Product");
    update.productId = product.id;
  }

  const designId = blankableId(data.designId, "design");
  if (designId !== undefined) {
    update.designId = designId ? (await assertRef(prisma.design, designId, storeId, "Design")).id : null;
  }

  const purityId = blankableId(data.purityId, "purity");
  if (purityId !== undefined) {
    update.purityId = purityId ? (await assertRef(prisma.purity, purityId, storeId, "Purity")).id : null;
  } else if (product && product.id !== item.productId) {
    update.purityId = product.purityId || null;
  }

  return updateItemRepo(item.id, update);
};

// Delete Item
export const deleteItem = async (id, storeId) => {
  const item = await loadOwnedItem(id, storeId);
  try {
    return await deleteItemRepo(item.id);
  } catch (error) {
    return rethrowDeleteError(error, "item");
  }
};
