const router = require("express").Router();
const Trade = require("../models/Trade");
const auth = require("../middlewares/auth.middleware");

const parseMonthParam = (value) => {
  if (!value || typeof value !== "string") {
    return null;
  }
  const [yearPart, monthPart] = value.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart) - 1;
  if (Number.isNaN(year) || Number.isNaN(month) || month < 0 || month > 11) {
    return null;
  }
  return { year, month };
};

router.get("/", auth, async (req, res) => {
  try {
    const { period, month } = req.query;
    const match = { teamCode: req.user.teamCode };
    if (!period || period === "CURRENT_MONTH") {
      const now = new Date();
      const parsed = parseMonthParam(month);
      const start = parsed
        ? new Date(Date.UTC(parsed.year, parsed.month, 1))
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      match.tradeDate = { $gte: start, $lt: end };
    }

    const data = await Trade.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$tradeDate" } },
          total: { $sum: "$finalAmount" }
        }
      },
      { $sort: { _id: -1 } }
    ]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: "Failed to load calendar data" });
  }
});

module.exports = router;
