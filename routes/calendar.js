const router = require("express").Router();
const Trade = require("../models/Trade");
const auth = require("../middlewares/auth.middleware");

router.get("/", auth, async (req, res) => {
  try {
    const { period } = req.query;
    const match = { teamCode: req.user.teamCode };
    const now = new Date();
    if (!period || period === "CURRENT_MONTH") {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
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
