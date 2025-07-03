// server.js

require("dotenv").config(); // Load .env variables

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 5000;

// ✅ Enable CORS for Webflow frontend
app.use(cors({
  origin: "https://buynow-aquaverse.webflow.io", // 🔐 Replace with your Webflow domain
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// 🔐 ENV variables
const {
  MERCHANT_ID,
  SECRET_KEY,
  PAYMENT_URL,
  FRONTEND_RETURN_URL,
  BACKEND_RETURN_URL,
  WEBFLOW_ORDER_API,
  SORASO_WEBHOOK,
} = process.env;

// 🔐 Helper function to generate payload + signature
function generatePayloadSignature(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64");
  const signature = crypto.createHmac("sha256", SECRET_KEY).update(payload).digest("hex");
  return { payload, signature };
}

// ✅ Start 2C2P payment (called by frontend)
app.post("/api/start-payment", async (req, res) => {
  const { amount, description, customerEmail } = req.body;

  const invoiceNo = "INV" + Date.now();
  const amountStr = parseFloat(amount).toFixed(2).replace(".", ""); // e.g. 100.00 => "10000"

  const paymentRequest = {
    version: "8.5",
    merchantID: MERCHANT_ID,
    invoiceNo,
    description: description || "Online Purchase",
    amount: amountStr,
    currencyCode: "764", // THB
    paymentChannel: "ALL",
    frontendReturnUrl: FRONTEND_RETURN_URL,
    backendReturnUrl: BACKEND_RETURN_URL,
    userDefined1: customerEmail || "no-email",
  };

  const { payload, signature } = generatePayloadSignature(paymentRequest);

  res.json({
    paymentURL: PAYMENT_URL,
    payload,
    signature,
  });
});

// ✅ Webhook (2C2P calls this after payment)
app.post("/api/payment-callback", async (req, res) => {
  const { payload, signature } = req.body;

  // 1. Verify signature
  const expectedSignature = crypto
    .createHmac("sha256", SECRET_KEY)
    .update(payload)
    .digest("hex");

  if (expectedSignature !== signature) {
    console.log("❌ Signature mismatch");
    return res.status(400).send("Invalid signature");
  }

  // 2. Decode payload
  const decodedPayload = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
  console.log("✅ Payment Callback Received:", decodedPayload);

  // 3. Proceed only if payment is successful
  if (decodedPayload.paymentStatus === "0000") {
    const invoiceNo = decodedPayload.invoiceNo;
    const customerEmail = decodedPayload.userDefined1 || "unknown";

    try {
      // ✅ 3A. Create order in Webflow
      await axios.post(WEBFLOW_ORDER_API, {
        orderRef: invoiceNo,
        email: customerEmail,
        amount: decodedPayload.amount,
        currency: decodedPayload.currencyCode,
        paymentMethod: decodedPayload.paymentChannelCode,
        status: "Paid",
      });

      console.log("✅ Webflow order created");

      // ✅ 3B. Trigger Soraso ticket
      await axios.post(SORASO_WEBHOOK, {
        orderId: invoiceNo,
        customer: customerEmail,
        issue: "New paid order",
      });

      console.log("✅ Soraso ticket created");
    } catch (error) {
      console.error("❌ Error sending to Webflow or Soraso:", error.message);
    }
  } else {
    console.log("❌ Payment not successful:", decodedPayload.paymentStatus);
  }

  // Always respond with 200
  res.status(200).send("ACK");
});

// 🟢 Simple health check
app.get("/", (req, res) => {
  res.send("2C2P Integration Server is Live ✅");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
