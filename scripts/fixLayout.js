const mongoose = require("mongoose");
require("dotenv").config({ path: __dirname + "/../.env" });

const userSchema = new mongoose.Schema({
  cockpitCardOrder: { type: [String], default: [] }
}, { strict: false });

const User = mongoose.models.User || mongoose.model("User", userSchema);

async function fixLayout() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/trade_screener");
  console.log("Connected to Mongo.");
  
  const users = await User.find({});
  for (const user of users) {
    if (!user.cockpitCardOrder.includes("options-bullish")) {
      user.cockpitCardOrder.push("options-bullish");
    }
    if (!user.cockpitCardOrder.includes("options-bearish")) {
      user.cockpitCardOrder.push("options-bearish");
    }
    await user.save();
  }
  console.log("Updated user layouts.");
  process.exit(0);
}

fixLayout();
