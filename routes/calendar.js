const router = require("express").Router();
const Trade = require("../models/Trade");

router.get("/", async (req, res) => {
  const data = await Trade.aggregate([
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$tradeDate" } },
        total: { $sum: "$finalAmount" }
      }
    }
  ]);
  res.json(data);
});

module.exports = router;