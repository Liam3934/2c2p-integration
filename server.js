require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const cors = require("cors");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(cors({ origin: "*" }));
app.use(bodyParser.json());

// 🔐 ENV Vars
const {
  MERCHANT_ID,
  SECRET_KEY,
  FRONTEND_RETURN_URL,
  BACKEND_RETURN_URL,
  WEBFLOW_ORDER_API,
  SORASO_WEBHOOK,
  CURRENCY_CODE
} = process.env;

// 🔐 Signature generator
function generateSignature(payloadBase64) {
  return crypto.createHmac("sha256", SECRET_KEY).update(payloadBase64).digest("hex");
}

// ✅ Start Payment Flow
app.post("/api/start-payment", async (req, res) => {
  const { amount, description, customerEmail } = req.body;

  const invoiceNo = "INV" + Date.now();
  const amountFormatted = parseFloat(amount).toFixed(2); // e.g., 1000.00

  const paymentData = {
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

  // 🔐 Encode & sign
  const payloadStr = JSON.stringify(paymentData);
  const payloadBase64 = Buffer.from(payloadStr).toString("base64");
  const signature = generateSignature(payloadBase64);

  try {
    const response = await axios.post(
      "https://sandbox-pgw.2c2p.com/payment/4.3/paymentToken", // ✅ Correct endpoint
      payloadBase64, // ✅ RAW base64 string as body
      {
        headers: {
          "Content-Type": "application/json",
          "X-Signature": signature
        }
      }
    );

    const { respCode, webPaymentUrl, respDesc } = response.data;

    if (respCode !== "0000") {
      return res.status(400).json({ error: "Token generation failed", respCode, respDesc });
    }

    return res.json({ redirectUrl: webPaymentUrl });

  } catch (err) {
    console.error("❌ Token API Error", err.response?.data || err.message);
    res.status(500).send("Failed to generate payment token.");
  }
});

// ✅ Webhook to handle backend return
app.post("/api/payment-callback", async (req, res) => {
  const { payload, signature } = req.body;

  const expectedSig = generateSignature(payload);
  if (expectedSig !== signature) return res.status(400).send("Invalid signature");

  const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
  console.log("✅ Payment Callback Received:", decoded);

  if (decoded.respCode === "0000") {
    try {
      // 📦 Webflow Order
      await axios.post(WEBFLOW_ORDER_API, {
        orderRef: decoded.invoiceNo,
        email: decoded.userDefined1,
        amount: decoded.amount,
        currency: decoded.currencyCode,
        paymentMethod: decoded.channelCode,
        status: "Paid"
      });

      // 🎫 Soraso Ticket
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

// ✅ Health
app.get("/", (_, res) => res.send("2C2P Payment Server Running ✅"));
app.listen(5000, () => console.log("🚀 Server running on port 5000"));
