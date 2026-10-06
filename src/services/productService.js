import prisma from "../config/db.js";
import {
  createProductRepo,
  getProductsByStore,
  getProductsByMetalIdRepo,
  updateProductRepo,
  deleteProductRepo,
  productInclude,
} from "../repositories/productRepository.js";
import { AppError, assertUniqueName, cleanString } from "../utils/validate.js";
import { assertRef, blankableId, findOwned, nameChanged, rethrowDeleteError } from "../utils/errorHandler.js";

/**
 * Resolves category / metal / purity / grade for a product. Every referenced id must
 * belong to the same store, purity must belong to the metal and grade to the purity.
 * `current` is the stored product on update (unsent fields keep their value).
 */
const resolveRefs = async (data, storeId, current = null) => {
  const out = {};

  if (data.categoryId !== undefined && data.categoryId !== null && data.categoryId !== "") {
    out.categoryId = (await assertRef(prisma.category, data.categoryId, storeId, "Category")).id;
  } else if (!current) {
    throw new AppError("Category is required.");
  }

  const metalId = blankableId(data.metalId, "metal");
  if (metalId !== undefined) out.metalId = metalId ? (await assertRef(prisma.metal, metalId, storeId, "Metal")).id : null;

  const purityId = blankableId(data.purityId, "purity");
  let purity = null;
  if (purityId !== undefined) {
    if (purityId) purity = await assertRef(prisma.purity, purityId, storeId, "Purity");
    out.purityId = purity ? purity.id : null;
    if (!purity) out.gradeId = null;
  }

  const effectiveMetalId = out.metalId !== undefined ? out.metalId : current?.metalId ?? null;
  if (purity && effectiveMetalId && purity.metalId !== effectiveMetalId) {
    throw new AppError(`Purity "${purity.name}" does not belong to the selected metal.`);
  }

  const effectivePurityId = out.purityId !== undefined ? out.purityId : current?.purityId ?? null;
  const gradeId = blankableId(data.gradeId, "grade");
  if (gradeId) {
    const grade = await assertRef(prisma.grade, gradeId, storeId, "Grade");
    if (effectivePurityId && grade.purityId !== effectivePurityId) {
      throw new AppError(`Grade "${grade.name}" does not belong to the selected purity.`);
    }
    out.gradeId = grade.id;
  } else if (gradeId === null) {
    out.gradeId = null;
  } else if (purity && (!current || current.purityId !== purity.id)) {
    // Purity chosen without a grade: default to the first grade of that purity (as before).
    const defaultGrade = await prisma.grade.findFirst({
      where: { purityId: purity.id, storeId: Number(storeId) },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    out.gradeId = defaultGrade ? defaultGrade.id : null;
  }
  return out;
};

export const createProduct = async (data, storeId) => {
  const name = await assertUniqueName(prisma.product, { storeId, name: data.name, label: "Product" });
  const refs = await resolveRefs(data, storeId);
  return createProductRepo({
    name,
    description: cleanString(data.description),
    image: data.image || null,
    ...refs,
    storeId: Number(storeId),
  });
};

export const getProducts = async (storeId) => getProductsByStore(Number(storeId));

export const getProductsByMetalId = async (metalId, storeId) => {
  if (!Number.isInteger(Number(metalId)) || Number(metalId) <= 0) throw new AppError("Metal ID is required.");
  return getProductsByMetalIdRepo(Number(metalId), Number(storeId));
};

export const getProductById = async (id, storeId) =>
  findOwned(prisma.product, id, storeId, "Product", { include: productInclude });

// Whitelisted update: name, description, image, category/metal/purity/grade.
export const updateProduct = async (id, data, storeId) => {
  const product = await findOwned(prisma.product, id, storeId, "Product");
  const update = await resolveRefs(data, storeId, product);

  if (nameChanged(data.name, product.name)) {
    update.name = await assertUniqueName(prisma.product, { storeId, name: data.name, excludeId: product.id, label: "Product" });
  }
  if (data.description !== undefined) update.description = cleanString(data.description);
  if (data.image !== undefined) update.image = data.image;

  return updateProductRepo(product.id, update);
};

export const deleteProduct = async (id, storeId) => {
  const product = await findOwned(prisma.product, id, storeId, "Product");
  try {
    return await deleteProductRepo(product.id);
  } catch (error) {
    return rethrowDeleteError(error, "product");
  }
};
