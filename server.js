require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const cors = require("cors");
const bodyParser = require("body-parser");
const axios = require("axios");
const crypto = require("crypto");
const payload = JSON.stringify(body);
const signature = crypto.createHmac("sha256", SECRET_KEY).update(payload).digest("hex");
const app = express();
app.use(cors({ origin: "*" }));
app.use(bodyParser.json());

const {
  MERCHANT_ID,
  SECRET_KEY,
  FRONTEND_RETURN_URL,
  BACKEND_RETURN_URL,
  WEBFLOW_ORDER_API,
  SORASO_WEBHOOK,
  CURRENCY_CODE
} = process.env;

// 🔐 Token generator
function generateSignature(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64");
  const signature = crypto.createHmac("sha256", SECRET_KEY).update(payload).digest("hex");
  return { payload, signature };
}

// ✅ API to get payment token
app.post("/api/start-payment", async (req, res) => {
  const { amount, description, customerEmail } = req.body;
  const invoiceNo = "INV" + Date.now();
  const amountFormatted = parseFloat(amount).toFixed(2);

  const data = {
    merchantID: MERCHANT_ID,
    invoiceNo,
    description: description || "Aquaverse Ticket",
    amount: amountFormatted,
    currencyCode: CURRENCY_CODE,
    paymentChannel: ["CC"],
    frontendReturnUrl: FRONTEND_RETURN_URL,
    backendReturnUrl: BACKEND_RETURN_URL,
    userDefined1: customerEmail || "guest@example.com"
  };

  try {
    const response = await axios.post(
      "https://sandbox-pgw.2c2p.com/paymentTokenV2",
      data,
      { headers: { "Content-Type": "application/json" } }
    );

    const { respCode, webPaymentUrl } = response.data;

    if (respCode !== "0000") {
      return res.status(400).json({ error: "Token generation failed" });
    }

    return res.json({ redirectUrl: webPaymentUrl });

  } catch (err) {
    console.error("❌ Token API Error", err.response?.data || err.message);
    res.status(500).send("Failed to generate payment token.");
  }
});

// ✅ Handle backend notification
app.post("/api/payment-callback", async (req, res) => {
  const { payload, signature } = req.body;

  const expectedSig = crypto.createHmac("sha256", SECRET_KEY).update(payload).digest("hex");
  if (expectedSig !== signature) return res.status(400).send("Invalid signature");

  const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
  console.log("✅ Payment Received:", decoded);

  if (decoded.respCode === "0000") {
    try {
      await axios.post(WEBFLOW_ORDER_API, {
        orderRef: decoded.invoiceNo,
        email: decoded.userDefined1,
        amount: decoded.amount,
        currency: decoded.currencyCode,
        paymentMethod: decoded.channelCode,
        status: "Paid"
      });

      await axios.post(SORASO_WEBHOOK, {
        orderId: decoded.invoiceNo,
        customer: decoded.userDefined1,
        issue: "New paid order"
      });

      console.log("✅ Webflow + Soraso triggered");
    } catch (err) {
      console.error("❌ Webhook Error", err.message);
    }
  }

  res.status(200).send("ACK");
});

// ✅ Health check
app.get("/", (_, res) => res.send("2C2P Payment Server Running ✅"));
app.listen(5000, () => console.log("🚀 Server on port 5000"));
