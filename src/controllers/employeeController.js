import * as employeeService from "../services/employeeService.js";
import { sendError } from "../utils/errorHandler.js";

// Validation for create and update lives in employeeService (one shared validator).

// Create Employee
export const createEmployee = async (req, res) => {
  try {
    const employee = await employeeService.createEmployee(req.body || {}, Number(req.query.storeId));
    res.status(201).json({ success: true, employee });
  } catch (err) {
    sendError(res, err, "Could not create employee.");
  }
};

// Get All Employees
export const getEmployees = async (req, res) => {
  try {
    const employees = await employeeService.getEmployees(Number(req.query.storeId));
    res.status(200).json({ success: true, employees });
  } catch (err) {
    sendError(res, err, "Could not load employees.");
  }
};

// Get Employee By ID
export const getEmployeeById = async (req, res) => {
  try {
    const employee = await employeeService.getEmployeeById(req.params.id, Number(req.query.storeId));
    res.status(200).json({ success: true, employee });
  } catch (err) {
    sendError(res, err, "Could not load employee.");
  }
};

// Update Employee
export const updateEmployee = async (req, res) => {
  try {
    const employee = await employeeService.updateEmployee(req.params.id, req.body || {}, Number(req.query.storeId));
    res.status(200).json({ success: true, employee });
  } catch (err) {
    sendError(res, err, "Could not update employee.");
  }
};

// Delete Employee
export const deleteEmployee = async (req, res) => {
  try {
    await employeeService.deleteEmployee(req.params.id, Number(req.query.storeId));
    res.status(200).json({ success: true, message: "Employee deleted successfully" });
  } catch (err) {
    sendError(res, err, "Could not delete employee.");
  }
};
