const mongoose = require('mongoose');
async function run() {
  await mongoose.connect('mongodb+srv://railway_db_access311:2ERiDjZx9QtoY4I6@cluster0.qpbzfpf.mongodb.net/?appName=Cluster0');
  await mongoose.connection.collection('foactivetrades').deleteMany({});
  console.log('Dropped all trades');
  process.exit(0);
}
run();
