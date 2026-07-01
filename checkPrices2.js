const mongoose = require('mongoose');
async function check() {
  await mongoose.connect('mongodb+srv://railway_db_access311:2ERiDjZx9QtoY4I6@cluster0.qpbzfpf.mongodb.net/?appName=Cluster0');
  const IntradayCandle = mongoose.model('IntradayCandle', new mongoose.Schema({}, {strict: false}));
  
  const polycab = await IntradayCandle.find({ symbol: 'POLYCAB', interval: 'FIVE_MINUTE', date: { $regex: '2026-06-30' } }).sort({ date: 1 }).lean();
  console.log('POLYCAB 12:40 (07:10 UTC):', polycab.find(c => c.date.includes('07:10')));
  
  process.exit(0);
}
check();
