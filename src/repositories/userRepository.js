import prisma from "../config/db.js";
import { publicUserSelect } from "../utils/publicSelect.js";

export const findUserByEmail = (email) => prisma.user.findUnique({ where: { email: String(email || "").trim().toLowerCase() } })
  .then((u) => u || prisma.user.findFirst({ where: { email: { equals: String(email || "").trim(), mode: "insensitive" } } }));

export const findUserById = (id) => prisma.user.findUnique({ where: { id: Number(id) } });

export const createUser = (data) => prisma.user.create({ data, select: publicUserSelect });

export const updateUser = (id, data) => prisma.user.update({ where: { id: Number(id) }, data, select: publicUserSelect });
