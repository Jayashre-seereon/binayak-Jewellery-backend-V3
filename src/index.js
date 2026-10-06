import './config/timezone.js';
import 'dotenv/config';
import express from "express";
import cors from "cors";
import userRoutes from "./routes/userRoutes.js";
import storeRoutes from "./routes/storeRoutes.js";
import brandRoutes from "./routes/brandRoutes.js";
import categoryRoutes from "./routes/CategoryRoutes.js";
import metalRoutes from "./routes/metalRoutes.js";
import purityRoutes from "./routes/purityRoutes.js";
import gradeRoutes from "./routes/gradeRoutes.js";
import designRoutes from "./routes/designRoutes.js";
import productRoutes from "./routes/productRoutes.js";
import itemRoutes from "./routes/itemRoutes.js";
import stoneRoutes from "./routes/stoneRoutes.js";
import employeeRoutes from "./routes/employeeRoutes.js";
import partytypeRoutes from "./routes/partytypeRoutes.js";
import partyMasterRoutes from "./routes/partyMasterRoutes.js";
import partyOpeningBalanceRoutes from "./routes/PartyOpeningBalanceRoutes.js";
import RateRoutes from "./routes/rateRoutes.js";
import Purchases from "./routes/purchaseRoutes.js";
import inventoryRoutes from "./routes/inventoryRoutes.js";
import inventoryTransferRoutes from "./routes/inventoryTransferRoutes.js"
import advanceReceiveRoutes from "./routes/advanceReceiveRoutes.js";
import salesRoutes from "./routes/salesRoutes.js";
import customerRoutes from "./routes/customerRoutes.js";
import accountingRoutes from "./routes/accountingRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import barcodeRoutes from "./routes/barcodeRoutes.js";
import stockEntryRoutes from "./routes/stockEntryRoutes.js";
import { securityHeaders, sanitizeResponses } from "./middleware/security.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";
import { USE_S3, serveLocalUploads, servePrivateFile, cleanupFailedUploads } from "./middleware/uploadS3.js";
import { authMiddleware } from "./middleware/authMiddleware.js";

for (const k of ["ACCESS_SECRET", "REFRESH_SECRET"]) {
  if (!process.env[k]) throw new Error(`Missing required environment variable ${k}`);
}
if (process.env.NODE_ENV === "production") {
  for (const k of ["ACCESS_SECRET", "REFRESH_SECRET"]) {
    if (String(process.env[k]).length < 32) throw new Error(`${k} must be at least 32 characters in production (use: openssl rand -hex 32).`);
  }
}
if (process.env.ACCESS_SECRET === process.env.REFRESH_SECRET) {
  console.warn("[security] ACCESS_SECRET and REFRESH_SECRET should be different values.");
}
const app = express();
app.disable("x-powered-by");
// Only trust X-Forwarded-For when a reverse proxy is really in front (TRUST_PROXY=1 = one hop);
// otherwise clients could pick their own IP and dodge rate limits (SEC31-02).
const trustProxy = process.env.TRUST_PROXY;
app.set("trust proxy", trustProxy === undefined || trustProxy === "" || trustProxy === "false" ? false : (/^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy));

const allowedOrigins = (process.env.CORS_ORIGINS ||
  "http://localhost:5173,http://localhost:4173,https://binayak-frontend.vercel.app")
  .split(",").map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
    credentials: false,
    exposedHeaders: ["Content-Disposition"],
  })
);
app.use(securityHeaders);
app.use(express.json({ limit: process.env.JSON_LIMIT || "2mb" }));
app.use(express.urlencoded({ extended: true, limit: process.env.JSON_LIMIT || "2mb" }));
app.use(sanitizeResponses);
app.use(cleanupFailedUploads);
if (!USE_S3) {
  app.use("/uploads", serveLocalUploads(express));
  app.get("/api/files/:store/private/:file", authMiddleware, servePrivateFile);
}

app.use("/api/users", userRoutes);
app.use("/api/stores", storeRoutes);
app.use("/api/brands", brandRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/metals", metalRoutes);
app.use("/api/purities", purityRoutes);
app.use("/api/grades", gradeRoutes);
app.use("/api/designs", designRoutes);
app.use("/api/products", productRoutes);
app.use("/api/items", itemRoutes);
app.use("/api/stones", stoneRoutes);
app.use("/api/employees", employeeRoutes);
app.use("/api/partytypes", partytypeRoutes);
app.use("/api/partymasters", partyMasterRoutes);
app.use("/api/partyopeningbalances", partyOpeningBalanceRoutes);
app.use("/api/rates", RateRoutes);
app.use("/api/purchases", Purchases);
app.use("/api/inventories", inventoryRoutes);
app.use("/api/inventory-transfer", inventoryTransferRoutes);
app.use("/api/advance-receives", advanceReceiveRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/accounting", accountingRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/barcode", barcodeRoutes);
app.use("/api/stock", stockEntryRoutes);

app.get("/", (req, res) => {
  res.send("API is running");
});
app.get("/api/health", (req, res) => res.json({ success: true, status: "ok", time: new Date().toISOString() }));

app.use("/api", notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
}); 