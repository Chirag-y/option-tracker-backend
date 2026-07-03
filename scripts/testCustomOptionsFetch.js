require("dotenv").config();
const { initializeSession, getSmartApiInstance } = require("../services/smartApiSession");
const { resolveOptionInstrument } = require("../services/customOptionsStrikeCatalog");

async function main() {
  await initializeSession();
  const inst = resolveOptionInstrument("NIFTY07JUL2624150CE");
  console.log("instrument", inst);
  const api = getSmartApiInstance();
  const pad = (n) => String(n).padStart(2, "0");
  const today = new Date();
  const from = new Date();
  from.setDate(today.getDate() - 3);
  const fStr = `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())} 09:15`;
  const tStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())} 15:30`;

  for (const ex of ["NFO", "NSE"]) {
    const r = await api.getCandleData({
      exchange: ex,
      symboltoken: inst.token,
      interval: "ONE_MINUTE",
      fromdate: fStr,
      todate: tStr,
    });
    const top = Array.isArray(r?.data) ? r.data.length : null;
    const nested = Array.isArray(r?.data?.data) ? r.data.data.length : null;
    console.log(ex, { status: r?.status, top, nested, message: r?.message, errorcode: r?.errorcode });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
