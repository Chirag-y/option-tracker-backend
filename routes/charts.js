const router = require("express").Router();
const Trade = require("../models/Trade");
const auth = require("../middlewares/auth.middleware");

router.get("/daily", auth, async (req, res) => {
  try {
    const data = await Trade.aggregate([
      { $match: { teamCode: req.user.teamCode } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$tradeDate" } },
          total: { $sum: "$finalAmount" }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: "Failed to load daily chart" });
  }
});

router.get("/monthly", auth, async (req, res) => {
  try {
    const data = await Trade.aggregate([
      { $match: { teamCode: req.user.teamCode } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$tradeDate" } },
          total: { $sum: "$finalAmount" }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: "Failed to load monthly chart" });
  }
});

module.exports = router;
