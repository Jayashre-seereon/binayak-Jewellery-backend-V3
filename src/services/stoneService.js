import prisma from "../config/db.js";
import {
  createStoneRepo,
  getStonesByStore,
  getStonesByProductIdAndItemIdRepo,
  updateStoneRepo,
  deleteStoneRepo,
} from "../repositories/stoneRepository.js";
import { AppError, assertUniqueName, cleanString } from "../utils/validate.js";
import { assertRef, findOwned, nameChanged, rethrowDeleteError } from "../utils/errorHandler.js";

const required = (v) => v !== undefined && v !== null && v !== "";

/** Item must belong to the chosen product when the item is tied to one (legacy items are not). */
const assertItemMatchesProduct = (item, product) => {
  if (item.productId && item.productId !== product.id) {
    throw new AppError(`Item "${item.name}" does not belong to product "${product.name}".`);
  }
};

const uniqueName = (storeId, name, productId, itemId, excludeId = null) =>
  assertUniqueName(prisma.stone, { storeId, name, excludeId, extraWhere: { productId, itemId }, label: "Stone" });

// Create
export const createStone = async (data, storeId) => {
  if (!required(data.productId)) throw new AppError("Product is required.");
  if (!required(data.itemId)) throw new AppError("Item is required.");
  const product = await assertRef(prisma.product, data.productId, storeId, "Product");
  const item = await assertRef(prisma.item, data.itemId, storeId, "Item");
  assertItemMatchesProduct(item, product);
  const name = await uniqueName(storeId, data.name, product.id, item.id);

  return createStoneRepo({
    name,
    description: cleanString(data.description),
    productId: product.id,
    itemId: item.id,
    storeId: Number(storeId),
  });
};

// Get All
export const getStones = async (storeId) => getStonesByStore(Number(storeId));

// Get By Product Id And Item Id
export const getStonesByProductIdAndItemId = async (productId, itemId, storeId) => {
  if (!Number.isInteger(Number(productId)) || Number(productId) <= 0) throw new AppError("Product ID is required.");
  if (!Number.isInteger(Number(itemId)) || Number(itemId) <= 0) throw new AppError("Item ID is required.");
  return getStonesByProductIdAndItemIdRepo(Number(productId), Number(itemId), Number(storeId));
};

// Get By Id
export const getStoneById = async (id, storeId) =>
  findOwned(prisma.stone, id, storeId, "Stone", { include: { product: true, item: true } });

// Update
export const updateStone = async (id, data, storeId) => {
  const stone = await findOwned(prisma.stone, id, storeId, "Stone");
  const update = {};

  const product = required(data.productId)
    ? await assertRef(prisma.product, data.productId, storeId, "Product")
    : await prisma.product.findUnique({ where: { id: stone.productId } });
  const item = required(data.itemId)
    ? await assertRef(prisma.item, data.itemId, storeId, "Item")
    : await prisma.item.findUnique({ where: { id: stone.itemId } });
  if (product.id !== stone.productId || item.id !== stone.itemId) {
    assertItemMatchesProduct(item, product);
    update.productId = product.id;
    update.itemId = item.id;
  }

  if (nameChanged(data.name, stone.name) || update.productId) {
    update.name = await uniqueName(storeId, data.name ?? stone.name, product.id, item.id, stone.id);
  }
  if (data.description !== undefined) update.description = cleanString(data.description);

  return updateStoneRepo(stone.id, update);
};

// Delete
export const deleteStone = async (id, storeId) => {
  const stone = await findOwned(prisma.stone, id, storeId, "Stone");
  try {
    return await deleteStoneRepo(stone.id);
  } catch (error) {
    return rethrowDeleteError(error, "stone");
  }
};
