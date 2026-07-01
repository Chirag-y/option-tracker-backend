const mongoose = require('mongoose');
mongoose.connect('mongodb+srv://railway_db_access311:2ERiDjZx9QtoY4I6@cluster0.qpbzfpf.mongodb.net/?appName=Cluster0').then(async () => {
  const FoActiveTrade = require('../models/FoActiveTrade');
  const open = await FoActiveTrade.countDocuments({ status: 'OPEN' });
  const total = await FoActiveTrade.countDocuments();
  console.log({open, total});
  process.exit(0);
});
