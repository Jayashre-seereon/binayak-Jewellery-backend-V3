import prisma from "../config/db.js";
import { publicStoreSelect } from "../utils/publicSelect.js";

// Never include the full Store row (it carries the password hash / refresh token).
const include = { store: { select: publicStoreSelect } };

// Create Employee (pass the transaction client so code allocation + insert are atomic)
export const createEmployeeRepo = (data, tx = prisma) => {
  return tx.employee.create({ data, include });
};

// Get All Employees by Store
export const getEmployeesByStore = (storeId) => {
  return prisma.employee.findMany({
    where: { storeId },
    include,
    orderBy: { createdAt: "desc" },
  });
};

// Get Employee By ID (store-scoped)
export const getEmployeeByIdRepo = (id, storeId) => {
  return prisma.employee.findFirst({
    where: { id, ...(storeId ? { storeId } : {}) },
    include,
  });
};

// Update Employee
export const updateEmployeeRepo = (id, data) => {
  return prisma.employee.update({ where: { id }, data, include });
};

// Delete Employee
export const deleteEmployeeRepo = (id) => {
  return prisma.employee.delete({ where: { id } });
};

export const countEmployees = () => {
  return prisma.employee.count();
};
