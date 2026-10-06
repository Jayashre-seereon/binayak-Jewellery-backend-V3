import prisma from "../config/db.js";
import {
  createEmployeeRepo,
  getEmployeesByStore,
  getEmployeeByIdRepo,
  updateEmployeeRepo,
  deleteEmployeeRepo,
} from "../repositories/employeeRepository.js";
import { generateEmployeeCode } from "../utils/employeeCode.js";
import { rethrowDeleteError } from "../utils/errorHandler.js";
import { AppError, cleanString, toDate, toMoney } from "../utils/validate.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** "XXXXXX1234" — list endpoints never return full bank account numbers. */
export const maskAccount = (acc) => {
  if (!acc) return acc;
  const s = String(acc);
  return s.length <= 4 ? "X".repeat(s.length) : `${"X".repeat(Math.max(4, s.length - 4))}${s.slice(-4)}`;
};

const parseMobile = (v, field, required) => {
  if (isBlank(v)) {
    if (required) throw new AppError(`${field} is required.`);
    return null;
  }
  const digits = String(v).replace(/\D/g, "");
  const ten = digits.length > 10 && (digits.startsWith("91") || digits.startsWith("0")) ? digits.slice(-10) : digits;
  if (!/^[0-9]{10}$/.test(ten)) throw new AppError(`${field} must be 10 digits.`);
  return ten;
};

/**
 * One validator for create and update. On update (`partial`), only sent keys are
 * validated/changed; `null`/"" clears optional fields.
 */
const buildEmployeeData = (data, { partial = false, current = null } = {}) => {
  const has = (k) => !partial || data[k] !== undefined;
  const out = {};

  if (has("name")) {
    const name = cleanString(data.name, 120);
    if (!name) throw new AppError("Employee Name is required.");
    out.name = name;
  }
  if (has("mobile")) out.mobile = parseMobile(data.mobile, "Mobile", true);
  if (has("phone")) {
    // Alternate / landline number: digits only, 6–12 long (e.g. 0674-2345678).
    const digits = isBlank(data.phone) ? "" : String(data.phone).replace(/\D/g, "");
    if (digits && !/^[0-9]{6,12}$/.test(digits)) throw new AppError("Phone must be 6 to 12 digits.");
    out.phone = digits || null;
  }
  if (has("email")) {
    const email = cleanString(data.email, 160);
    if (!email) throw new AppError("Email is required.");
    if (!EMAIL_RE.test(email)) throw new AppError("Invalid email format.");
    out.email = email;
  }
  if (has("dateOfJoining")) {
    out.dateOfJoining = toDate(data.dateOfJoining, { field: "Date of Joining", defaultValue: null, allowFutureDays: 366 });
  }
  if (has("basicSalary")) out.basicSalary = isBlank(data.basicSalary) ? null : toMoney(data.basicSalary, { field: "Basic Salary", max: 1e8 });
  if (has("specialAllowance")) {
    out.specialAllowance = isBlank(data.specialAllowance) ? null : toMoney(data.specialAllowance, { field: "Special Allowance", max: 1e8 });
  }
  if (has("bankAccountNo")) {
    const acc = isBlank(data.bankAccountNo) ? null : String(data.bankAccountNo).replace(/\s+/g, "");
    // A masked value echoed back from a list row means "unchanged".
    if (acc && current?.bankAccountNo && acc === maskAccount(current.bankAccountNo)) {
      // keep stored value
    } else {
      if (acc && !/^[0-9A-Za-z]{6,24}$/.test(acc)) throw new AppError("Bank account number must be 6–24 letters/digits.");
      out.bankAccountNo = acc;
    }
  }
  for (const [key, max] of [["fatherName", 120], ["webAddress", 200], ["bankName", 120], ["addressLine1", 300], ["addressLine2", 300]]) {
    if (has(key)) out[key] = cleanString(data[key], max);
  }
  return out;
};

const assertEmailFree = async (storeId, email, excludeId = null) => {
  const existing = await prisma.employee.findFirst({
    where: {
      storeId: Number(storeId),
      email: { equals: email, mode: "insensitive" },
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (existing) throw new AppError("An employee with this email already exists in this store.", 409);
};

const loadOwned = async (id, storeId) => {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new AppError("Invalid employee id.");
  const employee = await getEmployeeByIdRepo(n, Number(storeId));
  if (!employee) throw new AppError("Employee not found.", 404);
  return employee;
};

// Create Employee — code allocation and insert share one transaction (MST-01).
export const createEmployee = async (data, storeId) => {
  if (!storeId) throw new AppError("Store is required.");
  const fields = buildEmployeeData(data);
  await assertEmailFree(storeId, fields.email);

  return prisma.$transaction(async (tx) => {
    const empCode = await generateEmployeeCode(storeId, tx);
    return createEmployeeRepo({ ...fields, empCode, storeId: Number(storeId) }, tx);
  });
};

// Get All Employees (bank account masked)
export const getEmployees = async (storeId) => {
  if (!storeId) throw new AppError("Store is required.");
  const rows = await getEmployeesByStore(Number(storeId));
  return rows.map((e) => ({ ...e, bankAccountNo: maskAccount(e.bankAccountNo) }));
};

// Get Employee By Id (full record for the edit form)
export const getEmployeeById = async (id, storeId) => loadOwned(id, storeId);

// Update Employee — same validation as create, only sent fields change.
export const updateEmployee = async (id, data, storeId) => {
  const employee = await loadOwned(id, storeId);
  const fields = buildEmployeeData(data, { partial: true, current: employee });
  if (fields.email && fields.email.toLowerCase() !== String(employee.email).toLowerCase()) {
    await assertEmailFree(storeId, fields.email, employee.id);
  }
  return updateEmployeeRepo(employee.id, fields);
};

// Delete Employee
export const deleteEmployee = async (id, storeId) => {
  const employee = await loadOwned(id, storeId);
  try {
    return await deleteEmployeeRepo(employee.id);
  } catch (error) {
    return rethrowDeleteError(error, "employee");
  }
};
