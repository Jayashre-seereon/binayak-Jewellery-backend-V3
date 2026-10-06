import * as productService from "../services/productService.js";
import { sendError } from "../utils/errorHandler.js";

export const createProduct = async (req, res) => {
  try {
    const image = req.file ? req.file.location : null;
    const product = await productService.createProduct({ ...(req.body || {}), image }, Number(req.query.storeId));
    res.status(201).json({ success: true, product });
  } catch (err) {
    sendError(res, err, "Could not create product.");
  }
};

export const getProducts = async (req, res) => {
  try {
    const products = await productService.getProducts(Number(req.query.storeId));
    res.json({ success: true, products });
  } catch (err) {
    sendError(res, err, "Could not load products.");
  }
};

export const getProductsByMetalId = async (req, res) => {
  try {
    const products = await productService.getProductsByMetalId(req.params.metalId, Number(req.query.storeId));
    res.json({ success: true, products });
  } catch (err) {
    sendError(res, err, "Could not load products.");
  }
};

export const getProductById = async (req, res) => {
  try {
    const product = await productService.getProductById(req.params.id, Number(req.query.storeId));
    res.json({ success: true, product });
  } catch (err) {
    sendError(res, err, "Could not load product.");
  }
};

export const updateProduct = async (req, res) => {
  try {
    const image = req.file ? req.file.location : undefined;
    const product = await productService.updateProduct(req.params.id, { ...(req.body || {}), image }, Number(req.query.storeId));
    res.json({ success: true, product });
  } catch (err) {
    sendError(res, err, "Could not update product.");
  }
};

export const deleteProduct = async (req, res) => {
  try {
    await productService.deleteProduct(req.params.id, Number(req.query.storeId));
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    sendError(res, err, "Could not delete product.");
  }
};
