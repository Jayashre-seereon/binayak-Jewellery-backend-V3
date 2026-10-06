import prisma from "../config/db.js";

// CREATE
export const createGradeRepo = (data) => {
  return prisma.grade.create({ data });
};

// GET ALL
export const getGradesRepo = (storeId) => {
  return prisma.grade.findMany({
    where: { storeId },
    include: {
      purity: {
        include: {
          metal: true, 
        },
      },
    },
  });
};
// GET ALL GRADES BY PURITY ID
export const getGradesByPurityIdRepo = (purityId, storeId) => {
  return prisma.grade.findMany({
    where: {
      purityId,
      storeId,
    },
    include: {
      purity: {
        include: {
          metal: true,
        },
      },
    },
    orderBy: {
      id: "asc",
    },
  });
};
// GET BY ID
export const getGradeByIdRepo = (id) => {
  return prisma.grade.findUnique({
    where: { id },
    include: {
        purity: {
            include: {
                metal: true,
            },
        },
    },
  });
}

// UPDATE
export const updateGradeRepo = (id, data) => {
  return prisma.grade.update({
    where: { id },
    data,
  });
};

// DELETE
export const deleteGradeRepo = (id) => {
  return prisma.grade.delete({
    where: { id },
  });
};