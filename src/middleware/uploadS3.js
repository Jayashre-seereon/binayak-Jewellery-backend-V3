import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import multerS3 from "multer-s3";
import { S3Client } from "@aws-sdk/client-s3";
import { AppError } from "../utils/validate.js";

// Storage: AWS S3 when AWS_BUCKET_NAME is set, otherwise the local disk (UPLOAD_DIR, served at /uploads).
export const USE_S3 = Boolean(String(process.env.AWS_BUCKET_NAME || "").trim());
export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || "uploads");

const s3 = USE_S3
  ? new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    })
  : null;

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_FILES = 11;

// Only these types may be stored (SEC-13). Content type is fixed from this map, never sniffed,
// so an uploaded HTML/SVG/JS file can never be served back as active content.
const ALLOWED = {
  "image/jpeg": { exts: [".jpg", ".jpeg"], ext: ".jpg" },
  "image/png": { exts: [".png"], ext: ".png" },
  "image/webp": { exts: [".webp"], ext: ".webp" },
  "application/pdf": { exts: [".pdf"], ext: ".pdf" },
};

const fileFilter = (req, file, cb) => {
  const rule = ALLOWED[String(file.mimetype || "").toLowerCase()];
  const ext = path.extname(String(file.originalname || "")).toLowerCase();
  if (!rule || !rule.exts.includes(ext)) {
    return cb(new AppError("Only JPEG, PNG, WEBP images or PDF files can be uploaded."));
  }
  return cb(null, true);
};

const entityFolder = (req) => {
  const seg = String(req.baseUrl || "").split("/").filter(Boolean).pop() || "uploads";
  return seg.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "uploads";
};

const storeFolder = (req) => {
  const sid = Number(req.storeId ?? req.query?.storeId);
  return Number.isInteger(sid) && sid > 0 ? `s${sid}` : "shared";
};

// Seller ID / KYC documents (purchase "document" field) are private: never on the public
// /uploads mount, only through the authenticated, store-checked /api/files route (SEC31-05).
const PRIVATE_FIELDS = new Set(["document"]);

const objectKey = (req, file) => {
  const rule = ALLOWED[String(file.mimetype || "").toLowerCase()];
  const folder = PRIVATE_FIELDS.has(file.fieldname) ? "private" : entityFolder(req);
  // Random key; the client's file name is never used in the object path.
  return `${storeFolder(req)}/${folder}/${crypto.randomUUID()}${rule ? rule.ext : ""}`;
};

/** Public base for links to locally stored files. In production it must be configured, so a
 * spoofed Host header can never end up inside stored links (SEC31-10). */
const publicBase = (req) => {
  const configured = String(process.env.PUBLIC_API_URL || "").trim();
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") {
    throw new AppError("File uploads are not configured on this server (PUBLIC_API_URL is missing).", 500);
  }
  return `${req.protocol}://${req.get("host")}`;
};

// First bytes of every allowed type; the declared type must match the content (SEC31-13).
const MAGIC = {
  "image/jpeg": (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (b) => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  "application/pdf": (b) => b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-",
};
export const contentMatchesType = (mimetype, head) => {
  const check = MAGIC[String(mimetype || "").toLowerCase()];
  return Boolean(check && check(head));
};

/** Minimal multer storage engine for on-premise installs without S3. Sets file.location like multer-s3. */
const localDiskStorage = {
  _handleFile(req, file, cb) {
    let base;
    try { base = publicBase(req); } catch (e) { return cb(e); }
    const key = objectKey(req, file);
    const dest = path.join(UPLOAD_DIR, key);
    fs.mkdir(path.dirname(dest), { recursive: true }, (mkErr) => {
      if (mkErr) return cb(mkErr);
      const out = fs.createWriteStream(dest, { flags: "wx" });
      let size = 0;
      let checked = false;
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        file.stream.unpipe(out);
        file.stream.resume();
        out.destroy();
        fs.unlink(dest, () => cb(err));
      };
      file.stream.on("data", (chunk) => {
        if (!checked) {
          checked = true;
          if (!contentMatchesType(file.mimetype, chunk)) fail(new AppError("The file content does not match its type. Upload a real JPEG, PNG, WEBP or PDF."));
        }
        size += chunk.length;
      });
      file.stream.on("error", fail);
      out.on("error", fail);
      file.stream.pipe(out);
      out.on("finish", () => {
        if (failed) return;
        const isPrivate = key.split("/")[1] === "private";
        cb(null, { path: dest, size, key, location: `${base}/${isPrivate ? "api/files" : "uploads"}/${key}` });
      });
    });
  },
  _removeFile(req, file, cb) {
    fs.unlink(file.path, () => cb(null));
  },
};

/** Deletes locally stored files of a request that ended in an error (SEC31-13). */
export const cleanupFailedUploads = (req, res, next) => {
  res.on("finish", () => {
    if (USE_S3 || res.statusCode < 400) return;
    const files = [req.file, ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat())].filter(Boolean);
    for (const f of files) if (f.path && String(f.path).startsWith(UPLOAD_DIR)) fs.unlink(f.path, () => {});
  });
  next();
};

// upload config
export const upload = multer({
  storage: USE_S3
    ? multerS3({
        s3: s3,
        bucket: process.env.AWS_BUCKET_NAME,
        contentType: (req, file, cb) => cb(null, String(file.mimetype).toLowerCase()),
        contentDisposition: (req, file, cb) =>
          cb(null, String(file.mimetype).toLowerCase() === "application/pdf" ? "attachment" : "inline"),
        key: (req, file, cb) => cb(null, objectKey(req, file)),
      })
    : localDiskStorage,
  fileFilter,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: MAX_UPLOAD_FILES,
    fields: 50,
    fieldSize: 2 * 1024 * 1024,
  },
});

const SERVE_TYPES = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".pdf": "application/pdf" };
const setFileHeaders = (res, filePath) => {
  const type = SERVE_TYPES[path.extname(filePath).toLowerCase()];
  res.setHeader("Content-Type", type || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", type && type !== "application/pdf" ? "inline" : "attachment");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
};

/** Static handler for locally stored public uploads (images); never directory listings,
 * never the private folders. */
export const serveLocalUploads = (express) => {
  const stat = express.static(UPLOAD_DIR, { index: false, dotfiles: "deny", fallthrough: false, setHeaders: setFileHeaders });
  return (req, res, next) => {
    const parts = String(req.path || "").split("/").filter(Boolean);
    if (parts.length !== 3 || parts[1] === "private" || !/^(s\d+|shared)$/.test(parts[0]) || !/^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/.test(parts[2])) {
      return res.status(404).json({ success: false, message: "File not found." });
    }
    return stat(req, res, (err) => (err ? res.status(404).json({ success: false, message: "File not found." }) : next()));
  };
};

/** GET /api/files/:store/private/:file — private documents, only for their own store (or admin). */
export const servePrivateFile = (req, res) => {
  const { store, file } = req.params;
  const own = `s${Number(req.storeId ?? req.user?.storeId)}`;
  if (!/^s\d+$/.test(store) || !/^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/.test(String(file))) {
    return res.status(404).json({ success: false, message: "File not found." });
  }
  if (req.user?.role !== "ADMIN" && store !== own) {
    return res.status(404).json({ success: false, message: "File not found." });
  }
  const full = path.join(UPLOAD_DIR, store, "private", file);
  if (!full.startsWith(UPLOAD_DIR + path.sep)) return res.status(404).json({ success: false, message: "File not found." });
  setFileHeaders(res, full);
  return res.sendFile(full, (err) => {
    if (err && !res.headersSent) res.status(404).json({ success: false, message: "File not found." });
  });
};
