// Maps a transferred piece's master references (metal → purity → grade, category → product, item)
// from the source store to the destination store, matching by name and creating the master in the
// destination when it does not exist yet. A received piece then never points at another store's
// masters (SEC31-07): the destination's filters, reports and edits all work on its own data.

const sameName = (name) => ({ equals: String(name || "").trim(), mode: "insensitive" });

export const createMasterMapper = (tx, sourceStoreId, destStoreId) => {
  const src = Number(sourceStoreId);
  const dst = Number(destStoreId);
  const cache = new Map();

  const memo = async (key, fn) => {
    if (cache.has(key)) return cache.get(key);
    const v = await fn();
    cache.set(key, v);
    return v;
  };

  const metal = (id) => (!id ? null : memo(`metal:${id}`, async () => {
    const m = await tx.metal.findFirst({ where: { id, storeId: src }, select: { name: true, description: true } });
    if (!m) return null;
    const hit = await tx.metal.findFirst({ where: { storeId: dst, name: sameName(m.name) }, select: { id: true } });
    return (hit || (await tx.metal.create({ data: { name: m.name, description: m.description, storeId: dst }, select: { id: true } }))).id;
  }));

  const purity = (id) => (!id ? null : memo(`purity:${id}`, async () => {
    const p = await tx.purity.findFirst({ where: { id, storeId: src }, select: { name: true, description: true, metalId: true } });
    if (!p) return null;
    const metalId = await metal(p.metalId);
    if (!metalId) return null;
    const hit = await tx.purity.findFirst({ where: { storeId: dst, metalId, name: sameName(p.name) }, select: { id: true } });
    return (hit || (await tx.purity.create({ data: { name: p.name, description: p.description, metalId, storeId: dst }, select: { id: true } }))).id;
  }));

  const grade = (id) => (!id ? null : memo(`grade:${id}`, async () => {
    const g = await tx.grade.findFirst({ where: { id, storeId: src }, select: { name: true, description: true, percentage: true, purityId: true } });
    if (!g) return null;
    const purityId = await purity(g.purityId);
    if (!purityId) return null;
    const hit = await tx.grade.findFirst({ where: { storeId: dst, purityId, name: sameName(g.name) }, select: { id: true } });
    return (hit || (await tx.grade.create({ data: { name: g.name, description: g.description, percentage: g.percentage, purityId, storeId: dst }, select: { id: true } }))).id;
  }));

  const category = (id) => (!id ? null : memo(`category:${id}`, async () => {
    const c = await tx.category.findFirst({ where: { id, storeId: src }, select: { name: true, description: true } });
    if (!c) return null;
    const hit = await tx.category.findFirst({ where: { storeId: dst, name: sameName(c.name) }, select: { id: true } });
    return (hit || (await tx.category.create({ data: { name: c.name, description: c.description, storeId: dst }, select: { id: true } }))).id;
  }));

  const product = (id) => (!id ? null : memo(`product:${id}`, async () => {
    const p = await tx.product.findFirst({ where: { id, storeId: src }, select: { name: true, description: true, categoryId: true, metalId: true, purityId: true, gradeId: true } });
    if (!p) return null;
    const hit = await tx.product.findFirst({ where: { storeId: dst, name: sameName(p.name) }, select: { id: true } });
    if (hit) return hit.id;
    const categoryId = await category(p.categoryId);
    if (!categoryId) return null;
    const created = await tx.product.create({
      data: { name: p.name, description: p.description, categoryId, metalId: await metal(p.metalId), purityId: await purity(p.purityId), gradeId: await grade(p.gradeId), storeId: dst },
      select: { id: true },
    });
    return created.id;
  }));

  const item = (id) => (!id ? null : memo(`item:${id}`, async () => {
    const it = await tx.item.findFirst({ where: { id, storeId: src }, select: { name: true, description: true, productId: true, purityId: true } });
    if (!it) return null;
    const hit = await tx.item.findFirst({ where: { storeId: dst, name: sameName(it.name) }, select: { id: true } });
    if (hit) return hit.id;
    // Item codes are not copied: they must stay unique per store and are re-issued there if needed.
    const created = await tx.item.create({
      data: { name: it.name, description: it.description, productId: await product(it.productId), purityId: await purity(it.purityId), storeId: dst },
      select: { id: true },
    });
    return created.id;
  }));

  const stone = (id) => (!id ? null : memo(`stone:${id}`, async () => {
    const s = await tx.stone.findFirst({ where: { id, storeId: src }, select: { name: true } });
    if (!s) return null;
    const hit = await tx.stone.findFirst({ where: { storeId: dst, name: sameName(s.name) }, select: { id: true } });
    return hit ? hit.id : null;
  }));

  /** Destination-store ids for a piece's masters (null when the source had none). */
  return async (piece) => ({
    itemId: await item(piece.itemId),
    productId: await product(piece.productId),
    metalId: await metal(piece.metalId),
    purityId: await purity(piece.purityId),
    gradeId: await grade(piece.gradeId),
    stoneId: await stone(piece.stoneId),
  });
};
