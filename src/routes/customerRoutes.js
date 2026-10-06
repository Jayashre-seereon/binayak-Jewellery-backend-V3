import express from "express";
import {
  lookupCustomer,
  getCustomerHistory,
  getCustomers,
} from "../controllers/customerController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/lookup", authMiddleware, lookupCustomer);
router.get("/:id/history", authMiddleware, getCustomerHistory);
router.get("/get", authMiddleware, getCustomers);

export default router;
