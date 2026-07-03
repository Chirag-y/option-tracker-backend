const mongoose = require("mongoose");

const CustomSwingStockSchema = new mongoose.Schema({
  symbol: { type: String, required: true, unique: true, index: true },
  addedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("CustomSwingStock", CustomSwingStockSchema);
