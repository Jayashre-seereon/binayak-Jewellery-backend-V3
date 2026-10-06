import prisma from "../config/db.js";
import { publicStoreSelect } from "../utils/publicSelect.js";

// Never include the full Store row (it carries the password hash / refresh token).
export const itemInclude = {
  product: {
    include: {
      category: true,
      metal: true,
      purity: true,
      grade: true,
    },
  },
  design: true,
  purity: true,
  store: { select: publicStoreSelect },
};

const searchWhere = (storeId, search = "") => {
  const where = { storeId };
  const term = String(search || "").trim();
  if (term) {
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { barcode: { contains: term, mode: "insensitive" } },
      { description: { contains: term, mode: "insensitive" } },
      { product: { name: { contains: term, mode: "insensitive" } } },
      { design: { name: { contains: term, mode: "insensitive" } } },
    ];
  }
  return where;
};

export const createItemRepo = (data) => {
  return prisma.item.create({ data, include: itemInclude });
};

export const getItemsByStore = async (storeId, skip, take, search = "") => {
  const where = searchWhere(storeId, search);
  const [items, total] = await prisma.$transaction([
    prisma.item.findMany({
      where,
      include: itemInclude,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.item.count({ where }),
  ]);
  return { items, total };
};

/** Lean, unpaginated list for every item dropdown (purchase form, stock form…). */
export const getItemOptionsRepo = (storeId, search = "") => {
  return prisma.item.findMany({
    where: searchWhere(storeId, search),
    select: {
      id: true,
      name: true,
      barcode: true,
      productId: true,
      designId: true,
      purityId: true,
      product: {
        select: {
          id: true,
          name: true,
          categoryId: true,
          metalId: true,
          purityId: true,
          gradeId: true,
          metal: { select: { id: true, name: true } },
          purity: { select: { id: true, name: true } },
        },
      },
      design: { select: { id: true, name: true } },
    },
    orderBy: { name: "asc" },
  });
};

export const getItemsByProductIdRepo = (productId, storeId) => {
  return prisma.item.findMany({
    where: { productId, storeId },
    include: itemInclude,
    orderBy: { id: "asc" },
  });
};

export const getItemByIdRepo = (id, storeId) => {
  return prisma.item.findFirst({
    where: { id, ...(storeId ? { storeId } : {}) },
    include: itemInclude,
  });
};

export const updateItemRepo = (id, data) => {
  return prisma.item.update({ where: { id }, data, include: itemInclude });
};

export const deleteItemRepo = (id) => {
  return prisma.item.delete({ where: { id } });
};

export const countItems = () => {
  return prisma.item.count();
};
