require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const app = express();
app.use(cors({ origin: "*" }));
app.use(bodyParser.json());

const {
  MERCHANT_ID,
  SECRET_KEY,
  CURRENCY_CODE,
  FRONTEND_RETURN_URL,
  BACKEND_RETURN_URL,
  WEBFLOW_API_TOKEN,
  COLLECTION_ID,
  SORASO_WEBHOOK
} = process.env;

// 🔐 JWT Generator
function generateJWT(payload) {
  return jwt.sign(payload, SECRET_KEY, {
    algorithm: "HS256",
    header: {
      alg: "HS256",
      typ: "JWT"
    }
  });
}

// ✅ Start Payment: returns 2C2P redirect URL
app.post("/api/start-payment", async (req, res) => {
  const { amount, description, customerEmail, products } = req.body;

  const invoiceNo = "INV" + Date.now();
  const amountFormatted = parseFloat(amount).toFixed(2);

  const paymentPayload = {
    merchantID: MERCHANT_ID,
    invoiceNo,
    description: description || "Aquaverse Ticket",
    amount: parseFloat(amountFormatted),
    currencyCode: CURRENCY_CODE,
    paymentChannel: ["CC"],
    frontendReturnUrl: FRONTEND_RETURN_URL,
    backendReturnUrl: BACKEND_RETURN_URL,
    userDefined1: customerEmail || "guest@example.com",
    userDefined2: products || "N/A"
  };

  const jwtToken = generateJWT(paymentPayload);

  try {
    const response = await axios.post(
      "https://sandbox-pgw.2c2p.com/payment/4.3/paymentToken",
      { payload: jwtToken },
      { headers: { "Content-Type": "application/json" } }
    );

    const decoded = jwt.verify(response.data.payload, SECRET_KEY, { algorithms: ["HS256"] });

    if (decoded.respCode !== "0000") {
      return res.status(400).json({ error: "Token generation failed", ...decoded });
    }

    return res.json({ redirectUrl: decoded.webPaymentUrl });
  } catch (err) {
    console.error("❌ Token API Error", err.response?.data || err.message);
    res.status(500).send("Failed to generate payment token.");
  }
});

// ✅ Callback Handler: Called by 2C2P after payment
app.post("/api/payment-callback", async (req, res) => {
  const { payload } = req.body;

  console.log("📩 Received 2C2P Callback Payload:", payload);

  try {
    const decoded = jwt.verify(payload, SECRET_KEY, {
      algorithms: ["HS256"]
    });

    console.log("✅ Decoded Payment JWT:", decoded);

    if (decoded.respCode === "0000") {
      // ✅ Webflow order payload
      const webflowData = {
        orderNumber: decoded.invoiceNo,
        status: "Paid",
        customer: decoded.userDefined1,
        total: decoded.amount,
        products: decoded.userDefined2
      };

      console.log("📤 Creating Webflow CMS Order with:", webflowData);

      try {
        const webflowRes = await axios.post(
          `https://int-production.up.railway.app/api/webflow-order`,
          webflowData
        );
        console.log("✅ Webflow Order Response:", webflowRes.data);
      } catch (webflowErr) {
        console.error("❌ Webflow Order Error:", webflowErr.response?.data || webflowErr.message);
      }

      try {
        const sorasoRes = await axios.post(SORASO_WEBHOOK, {
          orderId: decoded.invoiceNo,
          customer: decoded.userDefined1 || "unknown",
          issue: "New paid order"
        });
        console.log("✅ Soraso Triggered:", sorasoRes.data);
      } catch (sorasoErr) {
        console.error("❌ Soraso Webhook Error:", sorasoErr.response?.data || sorasoErr.message);
      }

    } else {
      console.warn("⚠️ Payment failed:", decoded.respDesc);
    }

  } catch (err) {
    console.error("❌ Invalid callback JWT:", err.message);
    return res.status(400).send("Invalid signature");
  }

  res.status(200).send("ACK");
});
// ✅ Webflow CMS Order Creator
app.post("/api/webflow-order", async (req, res) => {
  const { orderNumber, status, customer, total, products } = req.body;

  if (!orderNumber || !customer || !total) {
    return res.status(400).json({ error: "Missing required order fields" });
  }

  const fieldData = {
    name: `Order ${orderNumber}`,
    slug: orderNumber.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    "order-number": orderNumber,
    "customer-email": customer,
    total: parseFloat(total),
    "status-2": status || "Paid",
    product: products || "N/A",
    _archived: false,
    _draft: false
  };

  console.log("📦 Webflow Payload:", fieldData);

  try {
    const response = await axios.post(
      `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items?live=true`,
      { fieldData },
      {
        headers: {
          Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.status(200).json({
      success: true,
      message: "Webflow CMS order created",
      data: response.data
    });
  } catch (err) {
    console.error("❌ Webflow API Error:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      error: err.message,
      details: err.response?.data || null
    });
  }
});
// ✅ Health check
app.get("/", (_, res) => {
  res.send("🚀 2C2P Payment Server Running");
});

// ✅ Dev endpoint to generate test JWT
app.get("/api/dev/generate-jwt", (req, res) => {
  const invoiceNo = "INV" + Date.now();
  const payload = {
    merchantID: MERCHANT_ID,
    invoiceNo,
    description: "Test Product",
    amount: 1000.00,
    currencyCode: CURRENCY_CODE
  };

  const token = generateJWT(payload);

  res.json({
    jwtToken: token,
    rawPayload: payload
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
});
console.log("📦 Sending Webflow CMS Order:", {
  name: `Order ${orderNumber}`,
  slug: orderNumber.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  "order-number": orderNumber,
  "customer-email": customer,
  "total": parseFloat(total),
  "status-2": status || "Paid",
  "product": products || "N/A"
});
