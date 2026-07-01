const mongoose = require('mongoose');

async function check() {
  await mongoose.connect('mongodb+srv://railway_db_access311:2ERiDjZx9QtoY4I6@cluster0.qpbzfpf.mongodb.net/?appName=Cluster0');
  const IntradayCandle = mongoose.model('IntradayCandle', new mongoose.Schema({}, {strict: false}));
  
  const polycab = await IntradayCandle.find({ symbol: 'POLYCAB-EQ', interval: 'FIVE_MINUTE' }).sort({ date: -1 }).limit(10);
  console.log('POLYCAB-EQ:', polycab.map(c => ({ date: c.date, close: c.close })));

  const polycab2 = await IntradayCandle.find({ symbol: 'POLYCAB', interval: 'FIVE_MINUTE' }).sort({ date: -1 }).limit(10);
  console.log('POLYCAB:', polycab2.map(c => ({ date: c.date, close: c.close })));
  
  const vmm = await IntradayCandle.find({ symbol: 'VMM-EQ', interval: 'FIVE_MINUTE' }).sort({ date: -1 }).limit(5);
  console.log('VMM-EQ:', vmm.map(c => ({ date: c.date, close: c.close })));
  
  process.exit(0);
}
check();
