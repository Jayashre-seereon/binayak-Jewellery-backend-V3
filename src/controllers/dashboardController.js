import { getDashboardSummaryService } from "../services/dashboardService.js";
import { safeMessage } from "../middleware/errorHandler.js";

export const getDashboardSummaryController = async (req, res) => {
  try {
    const storeId = Number(req.storeId || req.query.storeId) || 0;
    if (!storeId) return res.status(400).json({ success: false, message: "Please select a store." });

    const data = await getDashboardSummaryService(storeId, req.query.period);
    return res.status(200).json({ success: true, message: "Dashboard summary retrieved successfully", data });
  } catch (error) {
    const status = Number(error?.status || error?.statusCode) || 500;
    if (status >= 500) console.error("Dashboard Controller Error:", error);
    return res.status(status).json({
      success: false,
      message: status >= 500 ? "Failed to load dashboard summary." : safeMessage(error),
    });
  }
};
