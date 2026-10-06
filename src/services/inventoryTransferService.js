import { createMasterMapper } from "./inventory/masterMap.js";
import prisma from "../config/db.js";
import * as transferRepo from "../repositories/inventoryTransferRepository.js";
import { nextCounter } from "../utils/counter.js";
import { AppError, parseId, cleanString } from "../utils/validate.js";
import { allocateInventoryNumbers } from "./inventory/inventoryCodes.js";

const TX_OPTIONS = { maxWait: 20000, timeout: 120000 };
export const MAX_TRANSFER_ITEMS = 500;

const transferError = (message, status = 400) => new AppError(message, status);

// =====================================================
// 1. GENERATE TRANSFER NUMBER (inside the creating transaction)
// =====================================================

const generateTransferNo = async (tx, storeId) => {
  const seq = await nextCounter(storeId, "lastTransferNumber", tx);
  return `TRF-${String(seq).padStart(6, "0")}-S${String(storeId)}`;
};

// =====================================================
// 2. VALIDATION HELPERS
// =====================================================

const validateStore = async (storeId, label = "Store") => {
  const store = await prisma.store.findUnique({
    where: { id: Number(storeId) },
    select: { id: true },
  });
  if (!store) throw transferError(`${label} not found.`, 404);
  return store;
};

const parseInventoryIds = (inventoryIds) => {
  if (!Array.isArray(inventoryIds) || inventoryIds.length === 0) {
    throw transferError("At least one inventory item is required");
  }
  if (inventoryIds.length > MAX_TRANSFER_ITEMS) {
    throw transferError(`A transfer can contain at most ${MAX_TRANSFER_ITEMS} pieces.`);
  }
  const ids = inventoryIds.map((v) => parseId(v, "inventory id"));
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw transferError("Duplicate inventory items are not allowed");
  return unique;
};

/** Friendly pre-check; the authoritative check is the conditional update inside the transaction. */
const assertAvailable = async (ids, fromStoreId, { allowIds = new Set() } = {}) => {
  const inventories = await transferRepo.getInventoryForTransferRepo(ids, fromStoreId);
  if (inventories.length !== ids.length) {
    throw transferError("One or more inventory items do not belong to source store");
  }
  const invalid = inventories.find((inv) => !allowIds.has(inv.id) && inv.status !== "AVAILABLE");
  if (invalid) {
    throw transferError(`Inventory ${invalid.inventoryCode} is not available for transfer`);
  }
  return inventories;
};

const loadTransfer = async (transferId) => {
  const transfer = await transferRepo.getTransferByIdRepo(parseId(transferId, "transfer id"));
  if (!transfer) throw transferError("Inventory transfer not found", 404);
  return transfer;
};

/** Moves pieces AVAILABLE -> PENDING atomically; fails unless every piece was still AVAILABLE in the source. */
const reservePieces = async (tx, ids, fromStoreId) => {
  if (!ids.length) return;
  const res = await tx.inventory.updateMany({
    where: { id: { in: ids }, storeId: Number(fromStoreId), status: "AVAILABLE" },
    data: { status: "PENDING" },
  });
  if (res.count !== ids.length) {
    throw transferError("One or more pieces are no longer available (sold, reserved or already in another transfer). Please refresh and try again.", 409);
  }
};

// =====================================================
// 3. CREATE TRANSFER
// =====================================================

export const createTransferService = async ({
  fromStoreId,
  toStoreId,
  inventoryIds,
  narration,
}) => {
  fromStoreId = Number(fromStoreId);
  toStoreId = Number(toStoreId);

  if (!fromStoreId) throw transferError("Source store is required");
  if (!toStoreId) throw transferError("Destination store is required");
  if (fromStoreId === toStoreId) throw transferError("Source and destination store cannot be same");

  const uniqueInventoryIds = parseInventoryIds(inventoryIds);

  await validateStore(fromStoreId, "Source store");
  await validateStore(toStoreId, "Destination store");
  await assertAvailable(uniqueInventoryIds, fromStoreId);

  return prisma.$transaction(async (tx) => {
    await reservePieces(tx, uniqueInventoryIds, fromStoreId);

    const transferNo = await generateTransferNo(tx, fromStoreId);

    return transferRepo.createTransferRepo(tx, {
      transferNo,
      fromStoreId,
      toStoreId,
      narration: cleanString(narration, 1000),
      status: "PENDING",
      items: {
        create: uniqueInventoryIds.map((inventoryId) => ({
          inventory: { connect: { id: inventoryId } },
        })),
      },
    });
  }, TX_OPTIONS);
};

// =====================================================
// 4. GET ALL TRANSFERS
// =====================================================

export const getTransfersService = async ({
  storeId,
  status,
}) => {
  const st = status ? String(status).toUpperCase() : undefined;
  if (st && !["PENDING", "RECEIVED", "CANCELLED"].includes(st)) throw transferError("Invalid transfer status.");
  return transferRepo.getTransfersRepo({ storeId, status: st });
};

// =====================================================
// 5. GET TRANSFER BY ID
// =====================================================

export const getTransferByIdService = async (id) => loadTransfer(id);

// =====================================================
// 6. UPDATE PENDING TRANSFER
// =====================================================

export const updateTransferService = async ({
  transferId,
  fromStoreId,
  toStoreId,
  inventoryIds,
  narration,
}) => {
  const transfer = await loadTransfer(transferId);

  if (Number(transfer.fromStoreId) !== Number(fromStoreId)) {
    throw transferError("Only the source store can update this transfer", 403);
  }
  if (transfer.status !== "PENDING") throw transferError("Only PENDING transfer can be updated");

  const destination = Number(toStoreId || transfer.toStoreId);
  if (!destination) throw transferError("Destination store is required");
  if (Number(fromStoreId) === destination) throw transferError("Source and destination store cannot be same");
  await validateStore(destination, "Destination store");

  const uniqueInventoryIds = parseInventoryIds(inventoryIds);
  const oldIds = transfer.items.map((item) => Number(item.inventoryId));
  const oldSet = new Set(oldIds);
  const toRelease = oldIds.filter((id) => !uniqueInventoryIds.includes(id));
  const toAdd = uniqueInventoryIds.filter((id) => !oldSet.has(id));

  await assertAvailable(uniqueInventoryIds, fromStoreId, { allowIds: oldSet });

  return prisma.$transaction(async (tx) => {
    const flipped = await tx.inventoryTransfer.updateMany({
      where: { id: transfer.id, status: "PENDING", fromStoreId: Number(fromStoreId) },
      data: { toStoreId: destination, narration: cleanString(narration, 1000) },
    });
    if (flipped.count === 0) throw transferError("This transfer is no longer PENDING.", 409);

    if (toRelease.length) {
      await tx.inventory.updateMany({
        where: { id: { in: toRelease }, storeId: Number(fromStoreId), status: "PENDING" },
        data: { status: "AVAILABLE" },
      });
      await tx.inventoryTransferItem.deleteMany({ where: { transferId: transfer.id, inventoryId: { in: toRelease } } });
    }

    if (toAdd.length) {
      await reservePieces(tx, toAdd, fromStoreId);
      await tx.inventoryTransferItem.createMany({ data: toAdd.map((inventoryId) => ({ transferId: transfer.id, inventoryId })) });
    }

    return transferRepo.getTransferByIdRepo(transfer.id, tx);
  }, TX_OPTIONS);
};

// =====================================================
// 7. RECEIVE TRANSFER
// =====================================================

/**
 * Moves the pieces into the destination store. Pieces get the destination's next inventoryCode
 * but keep their barcode and tag so printed labels stay valid; only if the destination already
 * uses that barcode/tag is a new one issued and `relabelRequired` recorded (BRIEF rule 5).
 */
export const receiveTransferService = async ({
  transferId,
  toStoreId,
}) => {
  const transfer = await loadTransfer(transferId);

  if (Number(transfer.toStoreId) !== Number(toStoreId)) {
    throw transferError("You are not authorized to receive this transfer", 403);
  }
  if (transfer.status !== "PENDING") {
    throw transferError(`Transfer cannot be received from ${transfer.status} status`);
  }

  const destination = Number(transfer.toStoreId);
  const source = Number(transfer.fromStoreId);
  const relabeled = new Set();

  const result = await prisma.$transaction(async (tx) => {
    // First writer wins: a concurrent receive or cancel makes this count 0.
    const flipped = await tx.inventoryTransfer.updateMany({
      where: { id: transfer.id, status: "PENDING", toStoreId: destination },
      data: { status: "RECEIVED", receivedDate: new Date() },
    });
    if (flipped.count === 0) throw transferError("This transfer was already received or cancelled.", 409);

    const mapMasters = createMasterMapper(tx, source, destination);
    for (const item of transfer.items) {
      const inv = item.inventory;
      const [barcodeClash, tagClash] = await Promise.all([
        inv.barcodeNo
          ? tx.inventory.findFirst({ where: { storeId: destination, barcodeNo: inv.barcodeNo }, select: { id: true } })
          : null,
        inv.tagNo
          ? tx.inventory.findFirst({ where: { storeId: destination, tagNo: inv.tagNo }, select: { id: true } })
          : null,
      ]);
      const codes = await allocateInventoryNumbers(tx, destination, {
        code: true,
        barcode: Boolean(barcodeClash),
        tag: Boolean(tagClash),
      });

      const data = { storeId: destination, status: "AVAILABLE", inventoryCode: codes.inventoryCode, ...(await mapMasters(inv)) };
      if (barcodeClash || tagClash) {
        if (barcodeClash) data.barcodeNo = codes.barcodeNo;
        if (tagClash) data.tagNo = codes.tagNo;
        const extra = inv.extraDetails && typeof inv.extraDetails === "object" ? inv.extraDetails : {};
        data.extraDetails = {
          ...extra,
          relabelRequired: true,
          relabelReason: `Code already used in destination store (transfer ${transfer.transferNo})`,
          previousBarcodeNo: inv.barcodeNo,
          previousTagNo: inv.tagNo,
        };
        relabeled.add(inv.id);
      }

      const moved = await tx.inventory.updateMany({
        where: { id: inv.id, storeId: source, status: "PENDING" },
        data,
      });
      if (moved.count === 0) {
        throw transferError(`Piece ${inv.inventoryCode} is no longer in transit from the source store; the transfer cannot be received.`, 409);
      }
    }

    return transferRepo.getTransferByIdRepo(transfer.id, tx);
  }, TX_OPTIONS);

  return {
    ...result,
    relabelRequired: relabeled.size > 0,
    items: result.items.map((it) => ({ ...it, relabelRequired: relabeled.has(it.inventoryId) })),
  };
};

// =====================================================
// 8. CANCEL TRANSFER (source store only)
// =====================================================

export const cancelTransferService = async ({
  transferId,
  storeId,
}) => {
  const transfer = await loadTransfer(transferId);

  if (Number(transfer.fromStoreId) !== Number(storeId)) {
    throw transferError("Only the source store can cancel this transfer", 403);
  }
  if (transfer.status !== "PENDING") {
    throw transferError(`Transfer cannot be cancelled from ${transfer.status} status`);
  }

  const inventoryIds = transfer.items.map((item) => Number(item.inventoryId));

  return prisma.$transaction(async (tx) => {
    const flipped = await tx.inventoryTransfer.updateMany({
      where: { id: transfer.id, status: "PENDING", fromStoreId: Number(storeId) },
      data: { status: "CANCELLED" },
    });
    if (flipped.count === 0) throw transferError("This transfer was already received or cancelled.", 409);

    // Restore only pieces still in transit from the source (INV-20).
    if (inventoryIds.length) {
      await tx.inventory.updateMany({
        where: { id: { in: inventoryIds }, storeId: Number(transfer.fromStoreId), status: "PENDING" },
        data: { status: "AVAILABLE" },
      });
    }

    return transferRepo.getTransferByIdRepo(transfer.id, tx);
  }, TX_OPTIONS);
};
