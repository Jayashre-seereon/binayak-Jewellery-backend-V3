import prisma from "../config/db.js";

// Inventory reads never embed the whole Purchase row: after a stock transfer the piece still
// points at the source store's purchase, whose seller KYC / documents / costs are private to
// that store (SEC31-01/07). Same-store reads keep what the screens show.
export const pieceInclude = {
  purchase: {
    select: {
      id: true, storeId: true, invoiceNo: true, purchaseType: true, date: true, isOpeningStock: true,
      referenceNo: true, customerName: true, party: { select: { id: true, name: true } },
    },
  },
  purchaseItem: true,
  item: true,
  product: true,
  metal: true,
  purityMaster: true,
  grade: true,
  stone: true,
};

const COST_KEYS = ["rate", "makingCharges", "hallmarkCharges", "stoneAmount", "otherAmount", "discount", "totalAmount", "metalAmount", "wastagePercentage", "itemPhoto", "narration"];

/** Hides another store's purchase details on a transferred-in piece. */
export const scrubForeign = (piece, storeId) => {
  if (!piece || !piece.purchase || Number(piece.purchase.storeId) === Number(storeId)) return piece;
  const out = { ...piece, transferredIn: true };
  out.purchase = { id: null, invoiceNo: null, purchaseType: piece.purchase.purchaseType, date: piece.purchase.date, isOpeningStock: false, transferredIn: true };
  if (piece.purchaseItem) {
    const pi = { ...piece.purchaseItem };
    for (const k of COST_KEYS) delete pi[k];
    if (pi.extraDetails && typeof pi.extraDetails === "object") pi.extraDetails = null;
    out.purchaseItem = pi;
  }
  return out;
};
const scrubAll = (rows, storeId) => rows.map((r) => scrubForeign(r, storeId));

export const createInventoryRepo = async (data) => {
  return prisma.inventory.create({
    data,
    include: pieceInclude,
  });
};

export const getInventoriesRepo = async (storeId, filters = {}, options = {}) => {
  const where = {
      storeId,
      ...(filters.purchaseType
        ? { purchaseType: filters.purchaseType }
        : {}),
      ...(filters.status
        ? { status: filters.status }
        : {}),
      ...(filters.itemId
        ? { itemId: Number(filters.itemId) }
        : {}),
      ...(filters.productId
        ? { productId: Number(filters.productId) }
        : {}),
      ...(filters.metalId
        ? { metalId: Number(filters.metalId) }
        : {}),
      ...(filters.purityId
        ? { purityId: Number(filters.purityId) }
        : {}),
      ...(filters.barcodeNo
        ? { barcodeNo: filters.barcodeNo }
        : {}),
      ...(filters.tagNo
        ? { tagNo: filters.tagNo }
        : {}),
      ...(filters.huidNo
        ? { huidNo: filters.huidNo }
        : {}),
      ...(filters.barSerialNo
        ? { barSerialNo: filters.barSerialNo }
        : {}),
    };
  const search = String(options.search || "").trim();
  if (search) where.OR = [
    { inventoryCode: { contains: search, mode: "insensitive" } },
    { barcodeNo: { contains: search, mode: "insensitive" } },
    { tagNo: { contains: search, mode: "insensitive" } },
    { huidNo: { contains: search, mode: "insensitive" } },
    { barSerialNo: { contains: search, mode: "insensitive" } },
    { item: { name: { contains: search, mode: "insensitive" } } },
    { product: { name: { contains: search, mode: "insensitive" } } },
    { purchase: { invoiceNo: { contains: search, mode: "insensitive" } } },
    { purchaseItem: { purchaseItemCode: { contains: search, mode: "insensitive" } } },
  ];
  const query = {
    where,
    include: pieceInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  };
  if (Number.isInteger(options.skip)) query.skip = options.skip;
  if (Number.isInteger(options.take)) query.take = options.take;
  if (options.paginated) {
    const [inventories, total] = await prisma.$transaction([
      prisma.inventory.findMany(query), prisma.inventory.count({ where }),
    ]);
    return { inventories: scrubAll(inventories, storeId), total };
  }
  return scrubAll(await prisma.inventory.findMany(query), storeId);
};

export const getInventoryByIdRepo = async (id, storeId) => {
  const row = await prisma.inventory.findFirst({
    where: {
      id: Number(id),
      storeId,
    },
    include: pieceInclude,
  });
  return scrubForeign(row, storeId);
};

export const getInventoryByBarcodeRepo = async (barcodeNo, storeId) => {
  // Used by sales lookup and the Item Status screen: resolves barcode, tag, HUID or inventory code
  // (store-scoped) and returns the piece with its purchase, sale and transfer history.
  const code = String(barcodeNo || "").trim();
  const sid = Number(storeId);
  if (!code || !sid) return null;
  const include = {
    purchase: pieceInclude.purchase,
    purchaseItem: true,
    item: true,
    product: true,
    metal: true,
    purityMaster: true,
    grade: true,
    stone: true,
    store: { select: { id: true, storeName: true, location: true } },
    // Only this store's own sales of the piece (a transferred-in piece may have been sold elsewhere).
    saleItems: {
      where: { sale: { storeId: sid } },
      select: { id: true, totalAmount: true, sale: { select: { id: true, invoiceNo: true, saleDate: true, customerName: true, customerPhone: true, status: true } } },
      orderBy: { id: "desc" },
    },
    transferItems: {
      select: { id: true, transfer: { select: { id: true, transferNo: true, transferDate: true, receivedDate: true, status: true, fromStore: { select: { id: true, storeName: true } }, toStore: { select: { id: true, storeName: true } } } } },
      orderBy: { id: "desc" },
    },
  };
  const ci = { equals: code, mode: "insensitive" };
  for (const field of ["barcodeNo", "tagNo", "huidNo", "inventoryCode", "barSerialNo"]) {
    const hit = await prisma.inventory.findFirst({ where: { storeId: sid, [field]: ci }, include, orderBy: { id: "desc" } });
    if (hit) return scrubForeign(hit, sid);
  }
  return null;
};

export const MAX_LABELS_PER_REQUEST = 500;

export const getInventoriesForLabelsRepo = async (storeId, { ids = [], barcodeNos = [] }) => {
  const idList = ids
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);

  const barcodeList = barcodeNos
    .map((value) => String(value).trim())
    .filter(Boolean);

  if (idList.length === 0 && barcodeList.length === 0) {
    return [];
  }

  const inventories = await prisma.inventory.findMany({
    where: {
      storeId: Number(storeId),
      OR: [
        ...(idList.length > 0 ? [{ id: { in: idList } }] : []),
        ...(barcodeList.length > 0
          ? [
              {
                barcodeNo: {
                  in: barcodeList,
                },
              },
            ]
          : []),
      ],
    },
    include: pieceInclude,
    orderBy: {
      id: "asc",
    },
    take: MAX_LABELS_PER_REQUEST,
  });

  return scrubAll(inventories.filter(
    (inventory, index, self) =>
      index === self.findIndex((entry) => entry.id === inventory.id)
  ), storeId);
};

export const updateInventoryRepo = async (id, storeId, data, { notStatus = [] } = {}) => {
  return prisma.inventory.updateMany({
    where: {
      id: Number(id),
      storeId,
      ...(notStatus.length ? { status: { notIn: notStatus } } : {}),
    },
    data,
  });
};

/** Conditional status update: only applies while the piece is still in `fromStatus`. */
export const updateInventoryStatusRepo = async (
  id,
  storeId,
  status,
  fromStatus = undefined,
  extraDetails = undefined
) => {
  return prisma.inventory.updateMany({
    where: {
      id: Number(id),
      storeId,
      ...(fromStatus ? { status: fromStatus } : {}),
    },
    data: {
      status,
      ...(extraDetails !== undefined ? { extraDetails } : {}),
    },
  });
};

export const deleteInventoryRepo = async (id, storeId) => {
  return prisma.inventory.deleteMany({
    where: {
      id: Number(id),
      storeId,
    },
  });
};
