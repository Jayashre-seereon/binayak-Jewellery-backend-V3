import prisma from "../config/db.js";
import { publicStoreSelect } from "../utils/publicSelect.js";

export const findStoreByEmail = (email) => prisma.store.findUnique({ where: { email: String(email || "").trim().toLowerCase() } })
  .then((s) => s || prisma.store.findFirst({ where: { email: { equals: String(email || "").trim(), mode: "insensitive" } } }));

export const findStoreById = (id) => prisma.store.findUnique({ where: { id: Number(id) } });

export const createStoreRepo = (data) => prisma.store.create({ data, select: publicStoreSelect });

export const updateStoreRepo = (id, data) => prisma.store.update({ where: { id: Number(id) }, data, select: publicStoreSelect });

export const getAllStoresRepo = () => prisma.store.findMany({ select: publicStoreSelect, orderBy: { id: "asc" } });

export const getStoreOptionsRepo = () => prisma.store.findMany({ select: { id: true, storeName: true, location: true, state: true, city: true, gstNo: true, cinNo: true }, orderBy: { id: "asc" } });

export const getStoreByIdRepo = (id) => prisma.store.findUnique({ where: { id: Number(id) }, select: publicStoreSelect });

export const deleteStoreRepo = (id) => prisma.store.delete({ where: { id: Number(id) }, select: { id: true } });
