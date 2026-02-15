const router = require("express").Router();
const Trade = require("../models/Trade");
const auth = require("../middlewares/auth.middleware");

router.get("/", auth, async (req, res) => {
  try {
    const data = await Trade.aggregate([
      { $match: { teamCode: req.user.teamCode } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$tradeDate" } },
          total: { $sum: "$finalAmount" }
        }
      }
    ]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: "Failed to load calendar data" });
  }
});

module.exports = router;
